// A subtree that only moved, copied rather than repainted (issue #681).
//
// A card of widgets dragged across a pane changes nothing but where it is,
// and its pixels are already on the surface, one shift away. Where the card
// covers its box with opaque pixels nothing under it shows through, so the
// frame copies them where they went (`Window.scrollRegion`) and paints only
// what the copy cannot supply: what the move uncovered, the card's edges,
// and whatever is drawn over it.
//
// Every test paints the frame and then a full repaint of the same tree, and
// compares, step by step, so a pixel the copy got wrong is caught on the
// step that got it wrong rather than repaired by a later one. The ground the
// cards move over is striped both ways, so a copy that carried what was
// under a card, or left it behind, is a different colour somewhere.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot, Renderer } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const h = React.createElement;
const W = 320;
const H = 240;
// the pane the cards move in: inset from the window, under a header strip
const PANE = { x: 10, y: 30, width: W - 20, height: H - 40 };

async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

/** How many pixels differ, and the box around them. */
function compare(a, b) {
  let n = 0;
  let box = null;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] === b.data[i] &&
      a.data[i + 1] === b.data[i + 1] &&
      a.data[i + 2] === b.data[i + 2]
    ) {
      continue;
    }
    n++;
    const x = (i / 4) % W;
    const y = Math.floor(i / 4 / W);
    box = box
      ? {
          x0: Math.min(box.x0, x),
          y0: Math.min(box.y0, y),
          x1: Math.max(box.x1, x),
          y1: Math.max(box.y1, y),
        }
      : { x0: x, y0: y, x1: x, y1: y };
  }
  return { n, box };
}

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/** How much of `rect` the frame's damage repainted. */
function repaintedOf(rects, rect) {
  let sum = 0;
  for (const r of rects ?? []) {
    const hit = intersect(r, rect);
    if (hit) sum += hit.width * hit.height;
  }
  return sum;
}

/**
 * The ground: stripes both ways, drawn by an element the way a graph pane
 * draws the cards its mounted bodies sit on — culled to the pass, and able
 * to claim the box a card of its own moved through (`claimMove`), which is
 * what `<Flow>`'s drag step claims.
 */
class GroundNode extends Node {
  constructor(props, app) {
    super('moveground', props, app);
  }

  claimMove(from, to) {
    const x = Math.min(from.x, to.x) - 2;
    const y = Math.min(from.y, to.y) - 2;
    const right = Math.max(from.x + from.width, to.x + to.width) + 2;
    const bottom = Math.max(from.y + from.height, to.y + to.height) + 2;
    this.invalidate(
      false,
      { x, y, width: right - x, height: bottom - y },
      'content',
    );
  }

  paint(ctx) {
    super.paint(ctx);
    const box = this.abs;
    const damage = this.paintDamage() ?? box;
    const rects = [];
    for (let x = box.x; x < box.x + box.width; x += 14) {
      const band = { x, y: box.y, width: 7, height: box.height };
      if (overlaps(band, damage)) rects.push(band);
    }
    ctx.fillStyle = '#74b9ff';
    for (const r of rects) ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.fillStyle = 'rgba(214, 48, 49, 0.45)';
    for (let y = box.y; y < box.y + box.height; y += 10) {
      const band = { x: box.x, y, width: box.width, height: 5 };
      if (overlaps(band, damage)) {
        ctx.fillRect(band.x, band.y, band.width, band.height);
      }
    }
  }
}

registerElement('moveground', {
  create: (props, app) => new GroundNode(props, app),
});
process.on('exit', () => unregisterElement('moveground'));

/**
 * A card of widgets: a label, a bar, a status dot, a nested box with a fill
 * of its own. `style` goes on the card's own box — its background is what
 * makes the card opaque, or not.
 */
function card({ key = 'card', at, style = {}, label = 'build', extra }) {
  return h(
    'box',
    {
      key,
      style: {
        position: 'absolute',
        left: at.x,
        top: at.y,
        width: 110,
        height: 72,
        padding: 6,
        gap: 4,
        backgroundColor: '#ffffff',
        ...style,
      },
    },
    h(
      'box',
      { style: { flexDirection: 'row', gap: 5, alignItems: 'center' } },
      h('box', {
        style: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: '#00b894',
        },
      }),
      h('text', { style: { fontSize: 12, color: '#2d3436' } }, label),
    ),
    h(
      'box',
      { style: { height: 6, borderRadius: 3, backgroundColor: '#dfe6e9' } },
      h('box', {
        style: { width: 40, height: 6, backgroundColor: '#0984e3' },
      }),
    ),
    h('box', {
      style: {
        height: 14,
        borderWidth: 1,
        borderColor: '#636e72',
        backgroundColor: '#ffeaa7',
      },
    }),
    extra ?? null,
  );
}

/** The window: a header, and a clipped pane holding the ground and what
 *  `children` puts over it. */
function scene(children, paneStyle = {}) {
  return h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    h('box', { style: { height: 20, backgroundColor: '#636e72' } }),
    h(
      'box',
      {
        style: {
          margin: 10,
          marginTop: 10,
          flexGrow: 1,
          overflow: 'hidden',
          backgroundColor: '#ffffff',
          ...paneStyle,
        },
      },
      h('moveground', {
        key: 'ground',
        ref: (node) => {
          if (node) groundRef.current = node;
        },
        style: { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0 },
      }),
      ...children,
    ),
  );
}

const groundRef = { current: null };

async function mountStateful(x11Root, render) {
  let set;
  function App() {
    const [state, setState] = React.useState(0);
    set = setState;
    return render(state);
  }
  await new Promise((resolve) => x11Root.render(h(App), resolve));
  await new Promise((r) => setImmediate(r));
  return { setState: (v) => set(v) };
}

/**
 * Mount `render(step)` and walk it through `steps`. Each step's frame is
 * painted and then compared with a full repaint of the same tree; what is
 * returned per step is the difference, whether the window copied pixels in
 * that frame, the rects the frame repainted, and the root.
 */
async function walk(render, steps, { before, cap } = {}) {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, render);
    const root = groundRef.current.root;
    root._scheduled = false;
    root.flush();
    await settle(app);
    const wnd = root.window;
    // A backend whose pass is cheaper than an X server's says so on its
    // window, and keeps more rects a frame (`_damageRectCap`)
    if (cap) wnd.damageRectCap = cap;
    const real = wnd.scrollRegion.bind(wnd);
    const copies = [];
    wnd.scrollRegion = (rect, dx, dy) => {
      const ok = real(rect, dx, dy);
      copies.push({ rect: { ...rect }, dx, dy, ok });
      return ok;
    };
    const ctx = (root._ctx ??= wnd.getContext('2d'));
    const out = [];
    for (let i = 1; i <= steps; i++) {
      const copied = copies.length;
      const frames = [];
      const flush = root.flush.bind(root);
      root.flush = () => {
        const painting = root.needsPaint || root.needsLayout;
        const result = flush();
        if (painting) frames.push(root._lastDamageRects);
        return result;
      };
      try {
        // The commit lands with whatever `before` claimed, in the same
        // frame — as `<Flow>`'s drag step commits its bodies inside the
        // gesture's dispatch, after the pane claims its card
        before?.(i, root);
        Renderer.flushSyncFromReconciler(() => setState(i));
        for (let k = 0; k < 3; k++) {
          await new Promise((r) => setImmediate(r));
          await settle(app);
          root._scheduled = false;
          root.flush();
          await settle(app);
        }
      } finally {
        delete root.flush;
      }
      const partial = await readPixels(ctx);
      root.needsPaint = true;
      root._damage = null;
      root.flush();
      await settle(app);
      const full = await readPixels(ctx);
      out.push({
        step: i,
        diff: compare(partial, full),
        copies: copies.slice(copied),
        rects: frames[0] ?? null,
        root,
      });
    }
    return out;
  } finally {
    await app.close();
  }
}

// Steps of every size the scroll-blit tests mix, both directions, both
// axes and diagonal.
const PATH = [
  [0, 0],
  [1, 0],
  [3, 2],
  [3, 7],
  [-2, 12],
  [11, 12],
  [24, 4],
  [21, -9],
  [8, -4],
  [22, 10],
  [22, 11],
];
const at = (step) => ({ x: 40 + PATH[step][0], y: 30 + PATH[step][1] });
const cardRect = (step) => ({
  x: PANE.x + at(step).x,
  y: PANE.y + at(step).y,
  width: 110,
  height: 72,
});

function assertSteps(steps, { copied = true } = {}) {
  for (const s of steps) {
    assert.equal(
      s.diff.n,
      0,
      `step ${s.step}: ${s.diff.n} pixels differ from a full repaint, ` +
        `in ${JSON.stringify(s.diff.box)}`,
    );
    if (copied === null) continue;
    assert.equal(
      s.copies.length > 0,
      copied,
      `step ${s.step}: ${copied ? 'no' : 'a'} copy`,
    );
  }
}

test('a card that only moved is copied, and the frame paints around it', async () => {
  const steps = await walk(
    (step) => scene([card({ at: at(step) })]),
    PATH.length - 1,
  );
  assertSteps(steps);
  for (const s of steps) {
    const [copy] = s.copies;
    const [x0, y0] = PATH[s.step - 1];
    const [x1, y1] = PATH[s.step];
    assert.deepEqual([copy.dx, copy.dy], [x1 - x0, y1 - y0]);
    // the card's inside is the copy's; the frame paints its edges and what
    // the move uncovered
    const inside = cardRect(s.step);
    assert.ok(
      repaintedOf(s.rects, inside) < 0.25 * inside.width * inside.height,
      `step ${s.step}: repainted ${repaintedOf(s.rects, inside)} of the card`,
    );
  }
});

test('what the element under the card claims is painted around the copy, not through it', async () => {
  // The drag step of a graph pane: the element claims the box its own card
  // moved through, and the body mounted over the card moves with it.
  const steps = await walk(
    (step) => scene([card({ at: at(step) })]),
    PATH.length - 1,
    {
      before: (i) => groundRef.current.claimMove(cardRect(i - 1), cardRect(i)),
    },
  );
  assertSteps(steps);
  for (const s of steps) {
    const inside = cardRect(s.step);
    assert.ok(
      repaintedOf(s.rects, inside) < 0.25 * inside.width * inside.height,
      `step ${s.step}: repainted ${repaintedOf(s.rects, inside)} of the card`,
    );
  }
});

test('a card covered by wrappers that paint nothing is copied through them', async () => {
  // The shape `<Flow>` mounts a body in: a positioned box that clips, a box
  // that scales, and the body — which is the one with a background.
  const steps = await walk(
    (step) =>
      scene([
        h(
          'box',
          {
            key: 'outer',
            style: {
              position: 'absolute',
              left: at(step).x,
              top: at(step).y,
              width: 110,
              height: 72,
              overflow: 'hidden',
            },
          },
          h(
            'box',
            { style: { width: 110, height: 72 } },
            card({ at: { x: 0, y: 0 }, style: { position: 'relative' } }),
          ),
        ),
      ]),
    PATH.length - 1,
    {
      before: (i) => groundRef.current.claimMove(cardRect(i - 1), cardRect(i)),
    },
  );
  assertSteps(steps);
});

test('a card with nothing opaque under its widgets is repainted, not copied', async () => {
  const steps = await walk(
    (step) =>
      scene([card({ at: at(step), style: { backgroundColor: undefined } })]),
    4,
  );
  assertSteps(steps, { copied: false });
});

test('a translucent card is repainted, not copied', async () => {
  const steps = await walk(
    (step) =>
      scene([
        card({
          at: at(step),
          style: { backgroundColor: 'rgba(255, 255, 255, 0.8)' },
        }),
      ]),
    4,
  );
  assertSteps(steps, { copied: false });
});

const rounded = (step) =>
  scene([
    card({
      at: at(step),
      style: {
        borderRadius: 8,
        boxShadow: '0 2px 6px rgba(0, 0, 0, 0.4)',
      },
    }),
  ]);

test('a rounded card with a shadow is copied, and its corners and shadow repainted', async () => {
  // Cocoa's cap: each rect a pass the window can afford
  const steps = await walk(rounded, PATH.length - 1, { cap: 16 });
  assertSteps(steps);
});

test('on X11 a rounded card is repainted: its corners are more passes than it saves', async () => {
  const steps = await walk(rounded, 4);
  assertSteps(steps, { copied: false });
});

test('a sibling over the card is repainted where it is and where the copy carried it', async () => {
  const steps = await walk(
    (step) =>
      scene([
        card({ at: at(step) }),
        h('box', {
          key: 'over',
          style: {
            position: 'absolute',
            left: 90,
            top: 40,
            width: 50,
            height: 90,
            backgroundColor: 'rgba(108, 92, 231, 0.5)',
          },
        }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
  assert.ok(
    steps.some((s) => s.copies.length > 0),
    'the card is copied under the sibling on some step',
  );
});

test('a sibling over the card that moves too is repainted where the copy carried it', async () => {
  // Its old pixels over the card ride the copy; where it is now is not
  // where they landed, so its own claim of where it was is what repairs them.
  const steps = await walk(
    (step) =>
      scene([
        card({ at: at(step) }),
        h('box', {
          key: 'over',
          style: {
            position: 'absolute',
            left: 70 - PATH[step][1],
            top: 40 + PATH[step][0] / 2,
            width: 40,
            height: 30,
            backgroundColor: 'rgba(108, 92, 231, 0.5)',
          },
        }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
  assert.ok(
    steps.some((s) => s.copies.length > 0),
    'the card is copied under the moving sibling on some step',
  );
});

test('a sibling under the card that changes as the card moves shows nowhere through it', async () => {
  const steps = await walk(
    (step) =>
      scene([
        h('box', {
          key: 'under',
          style: {
            position: 'absolute',
            left: 70,
            top: 50,
            width: 80,
            height: 40,
            backgroundColor: step % 2 ? '#fdcb6e' : '#e17055',
          },
        }),
        card({ at: at(step) }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
});

test('a change inside the card in the same commit is painted over the copy', async () => {
  const steps = await walk(
    (step) =>
      scene([
        card({
          at: at(step),
          label: step % 2 ? 'build' : 'test',
          extra: h('box', {
            style: {
              height: 6,
              backgroundColor: step % 3 ? '#e84393' : '#00cec9',
            },
          }),
        }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
});

test('rows a scroll pane in the card pushes as it moves are repainted', async () => {
  // A row grows as the card moves: the rows under it move inside the pane,
  // which no claim names — the pane's own box is what the frame repaints.
  const rows = (step) =>
    Array.from({ length: 6 }, (_, i) =>
      h('box', {
        key: i,
        style: {
          height: i === 0 ? 6 + (step % 3) * 3 : 6,
          flexShrink: 0,
          backgroundColor: i % 2 ? '#a29bfe' : '#55efc4',
        },
      }),
    );
  // a card tall enough for the pane to keep its 20px under the widgets
  const steps = await walk(
    (step) =>
      scene([
        card({
          at: at(step),
          style: { height: 100 },
          extra: h(
            'box',
            { style: { height: 20, overflow: 'scroll' } },
            ...rows(step),
          ),
        }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
  assert.ok(
    steps.some((s) => s.copies.length > 0),
    'the card is copied with the pane in it on some step',
  );
});

test('a card the pane clips is copied where the pane shows it', async () => {
  const edge = (step) => ({
    x: PANE.width - 70 + PATH[step][0] / 2,
    y: PANE.height - 50 + PATH[step][1] / 2,
  });
  const steps = await walk((step) => {
    const p = edge(step);
    return scene([card({ at: { x: Math.round(p.x), y: Math.round(p.y) } })]);
  }, PATH.length - 1);
  assertSteps(steps, { copied: null });
});

test('two cards moved in one commit: one copied, one repainted', async () => {
  const steps = await walk(
    (step) =>
      scene([
        card({ key: 'a', at: at(step) }),
        card({
          key: 'b',
          at: { x: 150 + PATH[step][1], y: 90 + PATH[step][0] / 2 },
          label: 'deploy',
        }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
});

test('a jump farther than the card is repainted where it was and where it went', async () => {
  // The verb presents the box around both ends of a copy, so a jump across
  // the pane would present everything between them
  const steps = await walk(
    (step) => scene([card({ at: { x: 10 + step * 130, y: 30 } })]),
    1,
  );
  assertSteps(steps, { copied: false });
});

test('a box with nothing inside it is repainted, not copied', async () => {
  const steps = await walk(
    (step) =>
      scene([
        h('box', {
          key: 'plain',
          style: {
            position: 'absolute',
            left: at(step).x,
            top: at(step).y,
            width: 110,
            height: 72,
            backgroundColor: '#ffffff',
          },
        }),
      ]),
    4,
  );
  assertSteps(steps, { copied: false });
});

test('a badge hanging off the card is repainted where it was and where it went', async () => {
  // The card's box is not where its pixels end: what sticks out of it is
  // claimed with the reach, a pixel of slop and all.
  const steps = await walk(
    (step) =>
      scene([
        card({
          at: at(step),
          extra: h('box', {
            style: {
              position: 'absolute',
              top: -5,
              right: -5,
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: '#d63031',
            },
          }),
        }),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps);
});

/**
 * A box that draws a band across itself after its children — an element
 * that overrides `paint` — which nothing in core knows the reach of.
 */
class VeilNode extends Node {
  constructor(props, app) {
    super('moveveil', props, app);
  }

  paint(ctx) {
    super.paint(ctx);
    ctx.fillStyle = 'rgba(45, 52, 54, 0.35)';
    ctx.fillRect(this.abs.x, this.abs.y + 60, this.abs.width, 12);
  }
}

registerElement('moveveil', {
  create: (props, app) => new VeilNode(props, app),
});
process.on('exit', () => unregisterElement('moveveil'));

test('a card inside an element that draws over its children is repainted', async () => {
  const steps = await walk(
    (step) =>
      scene([
        h(
          'moveveil',
          {
            key: 'veil',
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            },
          },
          card({ at: at(step) }),
        ),
      ]),
    4,
  );
  assertSteps(steps, { copied: false });
});

test('a card under the border of the pane that clips it keeps the border on top', async () => {
  // Children clip to the border box, so a card at the pane's edge is under
  // its border, which is painted after it and does not move with it.
  const steps = await walk(
    (step) =>
      scene([card({ at: { x: -8 + PATH[step][0], y: 20 + PATH[step][1] } })], {
        borderWidth: 4,
        borderColor: '#2d3436',
      }),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
  assert.ok(
    steps.some((s) => s.copies.length > 0),
    'the card is copied under the border on some step',
  );
});

test('a card under the scrollbar of the pane it scrolls in keeps the bar on top', async () => {
  const steps = await walk(
    (step) =>
      scene([
        h(
          'box',
          {
            key: 'scroller',
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
              overflow: 'scroll',
            },
          },
          // content taller than the pane, so the bar shows
          h('box', { style: { height: 600, flexShrink: 0 } }),
          card({
            at: {
              x: PANE.width - 120 + PATH[step][0] / 2,
              y: 30 + PATH[step][1],
            },
          }),
        ),
      ]),
    PATH.length - 1,
  );
  assertSteps(steps, { copied: null });
  assert.ok(
    steps.some((s) => s.copies.length > 0),
    'the card is copied under the bar on some step',
  );
});
