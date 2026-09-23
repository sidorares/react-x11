// A subtree that moved and changed nothing else: a layer of cards panned
// across a graph, a panel sliding in, a dragged card with widgets in it.
//
// Two things are owed to it and nothing more. Its pixels were somewhere and
// are somewhere else, so the frame repaints both ends — once for the
// subtree, clipped to what can show them, not once per node inside it. And
// its nodes have new rects, which are the old ones moved — so a node yoga
// did not lay out again is translated, not re-read out of yoga.
//
// Every test paints the bounded frame and then a full repaint of the same
// tree and compares, and every placement test holds the rects against a
// tree laid out from scratch at the new position.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const h = React.createElement;
const W = 240;
const H = 200;

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

function differences(a, b) {
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (
      a.data[i] !== b.data[i] ||
      a.data[i + 1] !== b.data[i + 1] ||
      a.data[i + 2] !== b.data[i + 2]
    )
      n++;
  }
  return n;
}

/**
 * A clipped pane holding one absolutely positioned layer, wider and taller
 * than the pane, of `rows` cards — each a box with a label and a bar in it.
 * `at` is where the layer sits; `grow` makes one card taller, which is a
 * change inside the layer rather than a move of it.
 */
const paneRef = { current: null };

function paneTree({ at, grow = -1, rows = 6, scroll = null }) {
  const cards = [];
  for (let i = 0; i < rows; i++) {
    cards.push(
      h(
        'box',
        {
          key: i,
          style: {
            position: 'absolute',
            left: (i % 3) * 70,
            top: Math.floor(i / 3) * 60,
            width: 64,
            height: i === grow ? 54 : 44,
            padding: 3,
            gap: 2,
            backgroundColor: i % 2 ? '#dfe6e9' : '#74b9ff',
          },
        },
        h('text', { style: { fontSize: 9 } }, `card ${i}`),
        h(
          'box',
          { style: { height: 5, backgroundColor: '#2d3436' } },
          h('box', { style: { width: 20 + i * 5, height: 5 } }),
        ),
      ),
    );
  }
  if (scroll) {
    cards.push(
      h(
        'box',
        {
          key: 'scroller',
          ref: scroll.ref,
          style: {
            position: 'absolute',
            left: 0,
            top: 130,
            width: 120,
            height: 40,
            overflow: 'scroll',
          },
        },
        ...Array.from({ length: 8 }, (_, i) =>
          h('box', {
            key: i,
            style: {
              height: 12,
              flexShrink: 0,
              backgroundColor: i % 2 ? '#fab1a0' : '#55efc4',
            },
          }),
        ),
      ),
    );
  }
  return h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    h('box', { style: { height: 30, backgroundColor: '#636e72' } }),
    h(
      'box',
      {
        key: 'pane',
        ref: (node) => {
          if (node) paneRef.current = node;
        },
        style: {
          margin: 10,
          flexGrow: 1,
          overflow: 'hidden',
          backgroundColor: '#ffffff',
        },
      },
      h(
        'box',
        {
          key: 'layer',
          style: {
            position: 'absolute',
            left: at.x,
            top: at.y,
            width: 360,
            height: 260,
          },
        },
        ...cards,
      ),
    ),
  );
}

async function mountStateful(x11Root, render) {
  let set;
  const box = { current: null };
  function App() {
    const [state, setState] = React.useState(0);
    set = setState;
    return render(state, box);
  }
  await new Promise((resolve) => x11Root.render(h(App), resolve));
  await new Promise((r) => setImmediate(r));
  return { setState: (v) => set(v) };
}

/** The window node of the tree mounted last: every tree here has a pane. */
function windowOf() {
  return paneRef.current.root;
}

/** Every rect under the pane, in tree order. */
function rectsUnder(root) {
  const out = [];
  const walk = (n) => {
    if (n.yoga) out.push({ kind: n.kind, ...n.abs });
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out;
}

/** The frames painted while `act` settles, and a full repaint after. */
async function paintBothWays(app, root, act) {
  const frames = [];
  const original = root.flush.bind(root);
  root.flush = () => {
    const painting = root.needsPaint || root.needsLayout;
    const result = original();
    if (painting) {
      frames.push({
        box: root._lastDamage,
        rects: root._lastDamageRects,
      });
    }
    return result;
  };
  try {
    await act();
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setImmediate(r));
      await settle(app);
      root._scheduled = false;
      root.flush();
      await settle(app);
    }
  } finally {
    delete root.flush;
  }
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const partial = await readPixels(ctx);
  root.needsPaint = true;
  root._damage = null;
  root.flush();
  await settle(app);
  const full = await readPixels(ctx);
  return { frames, diff: differences(partial, full) };
}

/** The same tree laid out from scratch, for its rects. */
async function freshRects(props) {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    await new Promise((resolve) => x11Root.render(paneTree(props), resolve));
    await new Promise((r) => setImmediate(r));
    const root = windowOf();
    root.flush();
    return rectsUnder(root);
  } finally {
    await app.close();
  }
}

test('a moved layer repaints where it was and where it went, inside its pane', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, (state) =>
      paneTree({ at: { x: -40 + state * 7, y: -30 + state * 3 } }),
    );
    const root = windowOf();
    const { frames, diff } = await paintBothWays(app, root, () => setState(1));
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    const [frame] = frames;
    assert.ok(frame?.box, 'a moved layer must not repaint the window');
    // The pane is 10px in from the window's sides and under a 30px header;
    // the layer reaches past it on every side. Clipped, the frame stays
    // inside the pane — the header and the margin are not repainted.
    for (const rect of frame.rects) {
      assert.ok(
        rect.y >= 30 + 10 - 1,
        `claim at y=${rect.y} is above the pane`,
      );
      assert.ok(rect.x >= 10 - 1, `claim at x=${rect.x} is left of the pane`);
    }
  } finally {
    await app.close();
  }
});

test('a moved layer claims its subtree once, not once per node', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, (state) =>
      paneTree({ at: { x: 10 + state * 5, y: 10 }, rows: 12 }),
    );
    const root = windowOf();
    const moves = [];
    const own = root._claimLayoutMove;
    root._claimLayoutMove = function (rect, node, cap) {
      moves.push(node?.kind ?? null);
      return own.call(this, rect, node, cap);
    };
    try {
      const { diff } = await paintBothWays(app, root, () => setState(1));
      assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    } finally {
      delete root._claimLayoutMove;
    }
    // where it was and where it went, and the commit's two for the layer
    // whose style changed — not 12 cards × 4 nodes × 2 ends
    assert.ok(moves.length <= 4, `${moves.length} layout claims`);
  } finally {
    await app.close();
  }
});

test('the nodes of a moved layer land where a fresh layout puts them', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, (state) =>
      paneTree({ at: { x: 5 + state * 9, y: 4 + state * 6 } }),
    );
    const root = windowOf();
    // two moves: the first finds yoga's flags as the mount left them, the
    // second is the one that translates instead of walking
    for (const step of [1, 2]) {
      const { diff } = await paintBothWays(app, root, () => setState(step));
      assert.equal(diff, 0, `step ${step}: ${diff} pixels differ`);
      assert.deepStrictEqual(
        rectsUnder(root),
        await freshRects({ at: { x: 5 + step * 9, y: 4 + step * 6 } }),
        `step ${step}: every rect as a fresh layout has it`,
      );
    }
  } finally {
    await app.close();
  }
});

test('a moved layer is translated, not walked, where yoga did not lay it out', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, (state) =>
      paneTree({ at: { x: 5 + state * 9, y: 4 }, rows: 9 }),
    );
    const root = windowOf();
    await paintBothWays(app, root, () => setState(1));
    // count the nodes whose rect is read out of yoga on the next move
    let walked = 0;
    const patched = [];
    const count = (n) => {
      const proto = Object.getPrototypeOf(n);
      if (!patched.includes(proto) && typeof proto.absolutize === 'function') {
        const orig = proto.absolutize;
        proto.absolutize = function (x, y) {
          walked++;
          return orig.call(this, x, y);
        };
        patched.push(proto);
        patched.push(orig);
      }
      for (const c of n.children ?? []) count(c);
    };
    count(root);
    try {
      const { diff } = await paintBothWays(app, root, () => setState(2));
      assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    } finally {
      for (let i = 0; i < patched.length; i += 2) {
        patched[i].absolutize = patched[i + 1];
      }
    }
    // the window's own children, the pane, the layer and its nine cards:
    // what yoga laid out again. The cards' labels and bars — thirty-six
    // nodes — are moved with their cards.
    assert.ok(walked <= 16, `${walked} nodes walked for a move of the layer`);
    assert.deepStrictEqual(
      rectsUnder(root),
      await freshRects({ at: { x: 5 + 2 * 9, y: 4 }, rows: 9 }),
    );
  } finally {
    await app.close();
  }
});

test('a card that grows as the layer moves is laid out, and the rest follow', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, (state) =>
      paneTree({ at: { x: 5 + state * 9, y: 4 }, grow: state === 2 ? 1 : -1 }),
    );
    const root = windowOf();
    await paintBothWays(app, root, () => setState(1));
    const { diff } = await paintBothWays(app, root, () => setState(2));
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    assert.deepStrictEqual(
      rectsUnder(root),
      await freshRects({ at: { x: 5 + 2 * 9, y: 4 }, grow: 1 }),
    );
  } finally {
    await app.close();
  }
});

test('a scroll pane in a moved layer keeps its offset', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const { setState } = await mountStateful(x11Root, (state) =>
      paneTree({ at: { x: 5 + state * 9, y: 4 }, scroll: { ref } }),
    );
    const root = windowOf();
    ref.current.scrollTo(30);
    await paintBothWays(app, root, () => setState(1));
    const { diff } = await paintBothWays(app, root, () => setState(2));
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    const pane = ref.current;
    assert.strictEqual(pane.scrollY, 30);
    // the first row sits the offset above the pane's top
    assert.strictEqual(pane.children[0].abs.y, pane.abs.y - 30);
  } finally {
    await app.close();
  }
});

test('a claim is clipped to the box that clips the node making it', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const { setState } = await mountStateful(x11Root, (state) =>
      h(
        'window',
        { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
        h('box', { style: { height: 30, backgroundColor: '#636e72' } }),
        h(
          'box',
          {
            ref: (node) => {
              if (node) paneRef.current = node;
            },
            style: {
              margin: 10,
              height: 60,
              overflow: 'hidden',
              backgroundColor: '#ffffff',
            },
          },
          // twice as wide as the pane and hanging above it
          h('box', {
            style: {
              position: 'absolute',
              left: -40,
              top: -50,
              width: 400,
              height: 90,
              backgroundColor: state ? '#e17055' : '#0984e3',
            },
          }),
        ),
      ),
    );
    const root = windowOf();
    const { frames, diff } = await paintBothWays(app, root, () => setState(1));
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    const [frame] = frames;
    assert.ok(frame?.box, 'bounded');
    assert.ok(frame.box.y >= 30 + 10 - 1, `from y=${frame.box.y}`);
    assert.ok(frame.box.y + frame.box.height <= 30 + 10 + 60 + 1);
    assert.ok(frame.box.x >= 10 - 1 && frame.box.width <= W - 20 + 2);
  } finally {
    await app.close();
  }
});
