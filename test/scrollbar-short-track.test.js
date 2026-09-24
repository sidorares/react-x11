// A scroll pane shorter than the thumb's minimum length. The thumb fills the
// track rather than running past the pane: the pane paints its bars over its
// content and outside its clip, and a node that clips its children reaches
// no further than its own box (`_subtreeBounds`), so a thumb drawn past the
// box put ink where no claim could reach — and every move of the card
// holding the pane left a strip of it behind, or failed to draw one.
//
// The frame is painted bounded and then fully, and the two compared, as in
// test/rigid-move.test.js.
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
const W = 200;
const H = 160;

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
 * A card of a fixed height, moved by `step`, holding a block and a scroll
 * pane of rows taller than it. The pane asks for 20px, the thumb's minimum;
 * the block keeps its 38, a named size being its own floor; so the card's 50
 * squeezes the pane to 12, which a scroll pane may shrink to — its
 * `minHeight` is 0, as in CSS.
 */
function cardTree(step, paneRef) {
  return h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    h(
      'box',
      {
        style: {
          position: 'absolute',
          left: 20 + step * 7,
          top: 20 + step * 5,
          width: 90,
          height: 50,
          backgroundColor: '#dfe6e9',
        },
      },
      h('box', { style: { height: 38, backgroundColor: '#74b9ff' } }),
      h(
        'box',
        { ref: paneRef, style: { height: 20, overflow: 'scroll' } },
        ...Array.from({ length: 4 }, (_, i) =>
          h('box', {
            key: i,
            style: {
              height: 16,
              flexShrink: 0,
              backgroundColor: i % 2 ? '#fab1a0' : '#55efc4',
            },
          }),
        ),
      ),
    ),
  );
}

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

/** The frames painted while `act` settles, and a full repaint after. */
async function paintBothWays(app, root, act) {
  const frames = [];
  const original = root.flush.bind(root);
  root.flush = () => {
    const painting = root.needsPaint || root.needsLayout;
    const result = original();
    if (painting) frames.push({ box: root._lastDamage });
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

/** Where the pane's bars are, against the pane's own box. */
function assertBarsInside(pane, label) {
  const bars = pane._scrollbars();
  assert.ok(bars.length > 0, `${label}: the rows overflow the pane`);
  const box = pane.abs;
  for (const bar of bars) {
    assert.ok(
      bar.x >= box.x &&
        bar.y >= box.y &&
        bar.x + bar.width <= box.x + box.width &&
        bar.y + bar.height <= box.y + box.height,
      `${label}: the ${bar.axis} thumb at ${JSON.stringify({
        x: bar.x,
        y: bar.y,
        width: bar.width,
        height: bar.height,
      })} leaves the pane at ${JSON.stringify(box)}`,
    );
  }
}

test('a pane shorter than the minimum thumb keeps its thumb inside it', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const paneRef = React.createRef();
    const { setState } = await mountStateful(x11Root, (step) =>
      cardTree(step, paneRef),
    );
    const pane = paneRef.current;
    const root = pane.root;
    root.flush();
    // the premise: squeezed below the thumb's minimum, with rows to scroll
    assert.strictEqual(pane.abs.height, 12, 'the card squeezes the pane');
    assert.ok(pane.contentHeight > pane.abs.height, 'the rows overflow it');
    assertBarsInside(pane, 'mounted');

    for (const step of [1, 2, 3]) {
      const { frames, diff } = await paintBothWays(app, root, () =>
        setState(step),
      );
      // the premise again: a move is a bounded frame, or a full repaint
      // would cover whatever the claims miss
      assert.ok(
        frames.length > 0 && frames.every((frame) => frame.box),
        `step ${step}: the move must not repaint the window`,
      );
      assert.equal(diff, 0, `step ${step}: ${diff} pixels differ`);
      assertBarsInside(pane, `step ${step}`);
    }
  } finally {
    await app.close();
  }
});
