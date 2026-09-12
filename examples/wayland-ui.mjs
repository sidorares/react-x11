// The whole Tier D stack, drawing something that looks like a UI — without
// React, so each layer can be seen on its own.
//
//   bun examples/wayland-ui.mjs       (or node, with x11-dri >= 0.9)
//
// Rounded cards, a gradient header, a soft shadow, an SVG-style path and
// real shaped text, all on the GPU and handed to the compositor as a
// dma-buf. The pointer highlights a card and a click selects it; typing shows
// the keysym the keymap resolved; the titlebar is the compositor's to drag.
// Close the window, or press Escape.

import { WaylandConnection } from '../src/wayland/connection.js';
import { WaylandWindow } from '../src/wayland/window.js';
import { WaylandGLContext } from '../src/wayland/glcontext.js';
import { WaylandContext2D } from '../src/wayland/context2d.js';
import { WaylandSeat } from '../src/wayland/seat.js';
import { TextShaper } from '../src/wayland/text.js';
import { snapshotPNG } from '../src/wayland/readback.js';
import { charOf } from '../src/keysyms.js';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const ntk = require('ntk');

const conn = await WaylandConnection.open();
conn.on('error', (err) => {
  console.error('protocol error:', err.message);
  process.exit(1);
});

const win = WaylandWindow.createSync({
  conn,
  compositor: await conn.require('wl_compositor'),
  wmBase: await conn.require('xdg_wm_base'),
  title: 'react-x11 — Wayland Tier D',
  appId: 'react-x11.wayland-ui',
  width: 760,
  height: 520,
});
await win.whenConfigured;
const glctx = await WaylandGLContext.create({ conn, window: win });
glctx.beginFrame();
const ctx = new WaylandContext2D(glctx.gl, { target: glctx.backing });
const seat = await WaylandSeat.bind(conn);
const shaper = new TextShaper(new ntk.FontManager({ source: 'system' }));

// ---- state -----------------------------------------------------------

const CARDS = [
  { title: 'fd transport', body: `via ${conn.transport}` },
  { title: 'xdg-shell', body: 'configure / ack / commit' },
  { title: 'dma-buf', body: 'GBM buffer, zero copies' },
  { title: 'frame clock', body: 'wl_surface.frame' },
  { title: 'glyph atlas', body: 'ntk raster, GPU composite' },
  { title: 'stencil paths', body: 'the star is a Path2D' },
];
let hover = -1;
let selected = 0;
let lastKey = null;
let running = true;

const label = (text, size, weight) =>
  shaper.measure(text, { family: 'sans-serif', size, weight });
const shaped = new Map();
async function preshape() {
  const jobs = [
    ['__h1', 'react-x11 on Wayland', 26, 700],
    ['__h2', 'GLES over dma-buf — no X server', 14, 400],
  ];
  for (const c of CARDS) {
    jobs.push([`t:${c.title}`, c.title, 16, 600]);
    jobs.push([`b:${c.body}`, c.body, 12, 400]);
  }
  for (const [key, text, size, weight] of jobs)
    shaped.set(key, await label(text, size, weight));
}
await preshape();

async function statusText() {
  const bits = [`selected: ${CARDS[selected].title}`];
  if (lastKey) bits.push(`key ${lastKey}`);
  if (seat.xkb) bits.push(`keymap: ${seat.xkb.keys.size} keys`);
  const t = bits.join('   ·   ');
  if (!shaped.has(`s:${t}`)) shaped.set(`s:${t}`, await label(t, 12, 400));
  return shaped.get(`s:${t}`);
}

// ---- layout ----------------------------------------------------------

const COLS = 3;
const PAD = 24;
const HEADER = 96;

function cardRects(width) {
  const gap = 16;
  const cw = (width - PAD * 2 - gap * (COLS - 1)) / COLS;
  const ch = 92;
  return CARDS.map((_, i) => ({
    x: PAD + (i % COLS) * (cw + gap),
    y: HEADER + PAD + Math.floor(i / COLS) * (ch + gap),
    w: cw,
    h: ch,
  }));
}

function hitTest(x, y, width) {
  const rects = cardRects(width);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return i;
  }
  return -1;
}

// ---- input -----------------------------------------------------------

seat.on('keymap', (km, xkb) => {
  console.log(
    `keymap received over the socket: format ${km.format}, ${km.size} bytes, ${xkb?.keys.size ?? 0} keys parsed`,
  );
});
seat.on('motion', (ev) => {
  const h = hitTest(ev.x, ev.y, win.width);
  if (h !== hover) hover = h;
  seat.setCursor(h >= 0 ? 'pointer' : 'default');
});
seat.on('leave', () => {
  hover = -1;
});
seat.on('buttonpress', (ev) => {
  const h = hitTest(ev.x, ev.y, win.width);
  if (h >= 0) selected = h;
  else if (ev.y < HEADER) win.startMove(seat.seat, ev.serial);
});
seat.on('keydown', (ev) => {
  const ch = ev.keysym ? charOf(ev.keysym) : null;
  lastKey = `${ev.keycode}→0x${ev.keysym.toString(16)}${ch ? ` '${ch}'` : ''}${ev.repeat ? ' (repeat)' : ''}`;
  if (ev.keysym === 0xff1b) running = false; // Escape
});
win.on('close', () => {
  running = false;
});
win.on('error', (err) => {
  console.error('render error:', err.message);
  running = false;
});

// ---- paint -----------------------------------------------------------

const BG = '#12141a';
const CARD = '#1d212b';
const CARD_HOVER = '#262c3a';
const ACCENT = '#4f8cff';
const TEXT = '#e8eaf0';
const MUTED = '#8b93a7';

function drawText(entry, x, y, color) {
  if (!entry) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.drawTextRuns(entry.runs.map((r) => ({ ...r, color })));
  ctx.restore();
}

function star(cx, cy, r) {
  const p = new ntk.Path2D();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    const x = cx + Math.cos(a) * rr;
    const y = cy + Math.sin(a) * rr;
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

async function paint(width, height, t) {
  ctx.begin(width, height, t);

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  // header: a real multi-stop gradient
  const grad = ctx.createLinearGradient(0, 0, 0, HEADER);
  grad.addColorStop(0, '#1b2333');
  grad.addColorStop(0.6, '#161b27');
  grad.addColorStop(1, '#12141a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, HEADER);
  drawText(shaped.get('__h1'), PAD, 44, TEXT);
  drawText(shaped.get('__h2'), PAD, 68, MUTED);

  // an SVG-style path through the stencil filler, and a stroked one
  ctx.fillStyle = ACCENT;
  ctx.fill(star(width - 60, 48, 22));
  ctx.strokeStyle = MUTED;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke(star(width - 110, 48, 16));

  const rects = cardRects(width);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (i === selected)
      ctx.fillShadow(
        { x: r.x, y: r.y + 4, width: r.w, height: r.h },
        10,
        12,
        'rgba(79,140,255,0.35)',
      );
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 10);
    ctx.fillStyle = i === hover ? CARD_HOVER : CARD;
    ctx.fill();
    if (i === selected) {
      ctx.beginPath();
      ctx.roundRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1, 10);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x + 12, r.y, r.w - 24, r.h);
    ctx.clip();
    drawText(
      shaped.get(`t:${CARDS[i].title}`),
      r.x + 14,
      r.y + 34,
      i === selected ? ACCENT : TEXT,
    );
    drawText(shaped.get(`b:${CARDS[i].body}`), r.x + 14, r.y + 58, MUTED);
    ctx.restore();
  }

  ctx.fillStyle = '#0d0f14';
  ctx.fillRect(0, height - 34, width, 34);
  drawText(await statusText(), PAD, height - 12, MUTED);
  ctx.end();
}

// ---- loop ------------------------------------------------------------

console.log(
  `window ${win.width}x${win.height} via ${conn.transport}; GL ${glctx.glVersion?.string}`,
);
let frames = 0;
let last = Date.now();
const startedAt = Date.now();

while (running) {
  const { width, height } = glctx.beginFrame();
  await paint(width, height, Date.now() - startedAt);
  if (process.env.WL_SNAPSHOT && frames === 2) {
    // The frame we are about to hand over, read straight off the GPU: the
    // renderer checked without a screenshot of the compositor.
    fs.writeFileSync(
      process.env.WL_SNAPSHOT,
      snapshotPNG(glctx.gl, width, height),
    );
    console.log(`\nsnapshot -> ${process.env.WL_SNAPSHOT}`);
  }
  const vsync = await glctx.endFrame('all');
  frames++;
  const now = Date.now();
  if (now - last >= 2000) {
    const s = ctx.shapeStats;
    process.stdout.write(
      `\r${width}x${height}  ${((frames * 1000) / (now - last)).toFixed(0)} fps  ${s.batches} batches  ${s.quads} quads  ${s.glyphs} glyphs  ${s.paths} paths   `,
    );
    frames = 0;
    last = now;
  }
  await vsync;
  if (
    process.env.WL_DEMO_MS &&
    Date.now() - startedAt > Number(process.env.WL_DEMO_MS)
  )
    running = false;
}

console.log('\nshutting down');
ctx.destroy();
glctx.destroy();
win.destroy();
conn.destroy();
process.exit(0);
