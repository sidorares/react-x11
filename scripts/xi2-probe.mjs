#!/usr/bin/env node
// What does selecting XI2 cost a window on the wire?
//
// This is the measurement behind `xi2: 'auto'` (docs/events.md, and the long
// comment in WindowNode.realize). It cannot live in `npm run bench`: the
// in-process X server that lane runs against has no XInput2, so the whole
// question is invisible there. Point this at a real display instead.
//
//   node scripts/xi2-probe.mjs              # $DISPLAY
//   DISPLAY=:99 node scripts/xi2-probe.mjs  # another server
//
// It creates a plain ntk window, warps the pointer across it a few hundred
// times, and counts the bytes the server sends back under four selections.
// The warp traffic itself is the same in all four and is subtracted out, so
// what is left is the per-motion-event cost of each.
//
// The two numbers the design turns on:
//
//   - an XIMotion is about four times a core MotionNotify, and motion is the
//     one event that keeps arriving at frame rate for as long as the pointer
//     is over the window;
//   - "XI2 alone" and "core + XI2" are byte-identical, because an XI2
//     selection replaces the core one for the same event type. So the core
//     PointerMotion bit is free once XI2 is on, and making *that* lazy would
//     save nothing at all.
//
// The last row is `PointerMotionHint`, X's own answer to motion traffic. It
// reads as ~0 because ntk sets the bit and nothing ever follows up with the
// QueryPointer the hint requires (sidorares/ntk#319) — so it is one event and
// then silence, not a working option. Left in because it is the thing a
// reader will ask about next.

import net from 'node:net';
import { createClient } from 'ntk';

const DISPLAY = process.env.DISPLAY ?? ':0';
const STEPS = Number(process.env.XI2_PROBE_STEPS ?? 600);

function socketPath(display) {
  const local = display.replace(/^:/, '').split('.')[0];
  return `/tmp/.X11-unix/X${local}`;
}

/** Count the bytes the server sends us, by wrapping the socket. */
function counted(stream) {
  const stats = { bytesIn: 0 };
  stream.on('data', (chunk) => {
    stats.bytesIn += chunk.length;
  });
  return stats;
}

async function connect() {
  const stream = net.connect(socketPath(DISPLAY));
  await new Promise((resolve, reject) => {
    stream.once('connect', resolve);
    stream.once('error', reject);
  });
  const stats = counted(stream);
  const app = await createClient({ stream });
  return { app, stats };
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

async function sweep(label, { core, xi2, hint }) {
  const { app, stats } = await connect();
  const wnd = app.createWindow({ x: 80, y: 80, width: 600, height: 400 });
  wnd.map();
  if (core) wnd.on('mousemove', () => {});
  const selected = xi2 ? await wnd.selectXI2() : false;
  if (hint) wnd.setMouseHintOnly(true);
  await settle(app);

  const root = app.X.display.screen[0].root;
  const before = stats.bytesIn;
  for (let i = 0; i < STEPS; i++) {
    // inside the window, and never on the same pixel twice in a row
    app.X.WarpPointer(
      0,
      root,
      0,
      0,
      0,
      0,
      100 + (i % 560),
      100 + ((i * 7) % 360),
    );
    if (i % 20 === 19) await settle(app);
  }
  await settle(app);
  const bytes = stats.bytesIn - before;
  await app.close();
  return { label, bytes, perMove: bytes / STEPS, selected };
}

const rows = [];
rows.push(await sweep('nothing selected', { core: false, xi2: false }));
rows.push(await sweep('core PointerMotion', { core: true, xi2: false }));
rows.push(await sweep('core + XI2 Motion', { core: true, xi2: true }));
rows.push(await sweep('XI2 Motion, core bit off', { core: false, xi2: true }));
rows.push(
  await sweep('core + PointerMotionHint', {
    core: true,
    xi2: false,
    hint: true,
  }),
);

const floor = rows[0].perMove;
const hasXI2 = rows.some((r) => r.selected);
console.log(
  `display ${DISPLAY} — XInput2 ${hasXI2 ? 'present' : 'ABSENT (every XI2 row will read as core)'}`,
);
console.log(`pointer warped ${STEPS} times inside the window, per selection\n`);
const pad = (s, n) => String(s).padStart(n);
console.log(
  `${'selection'.padEnd(28)} ${pad('bytes in', 9)} ${pad('per move', 9)} ${pad('at 60 Hz', 11)}`,
);
for (const row of rows) {
  // `net` would shadow the imported socket module; this is the per-event
  // cost with the warp traffic every row shares taken off
  const cost = Math.max(0, row.perMove - floor);
  console.log(
    `${row.label.padEnd(28)} ${pad(row.bytes, 9)} ${pad(`${cost.toFixed(1)} B`, 9)} ${pad(`${((cost * 60) / 1024).toFixed(1)} KB/s`, 11)}`,
  );
}
