// Mounting a commitful of rows into a pane that already holds a lot of them
// (issue #397). React inserts a virtualized list's window one `insertBefore`
// at a time, and every insert used to pay for the whole pane: a
// `paintBounds()` walk for the before-damage, a scan of every sibling in
// front of the new row to find its yoga slot, and two `indexOf` over the
// child list. A commit of N rows into a pane of M nodes cost O(N x M).
//
// The tests come in two halves. The counting ones assert the shape of the
// cost — the same commit against a pane four times as long asks the same
// number of questions — and are what a reintroduction trips over. The rest
// assert that the bookkeeping which replaced the scans is *right*: a child's
// remembered index, and the count of children standing outside the parent's
// yoga tree, both of which are only ever visible as a row landing in the
// wrong place.
import assert from 'node:assert';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/** Every node's `_nonYogaKids` against a fresh count of the same thing. The
 * counter is maintained by hand at the three places `children` is spliced,
 * so this is the check that none of them was missed. */
function assertCountsExact(node, where) {
  const outside = node.children.filter((c) => !c.yoga || c.isWindow).length;
  assert.strictEqual(
    node._nonYogaKids,
    outside,
    `${where}: <${node.kind}> counts ${node._nonYogaKids} children outside ` +
      `its yoga tree, but ${outside} are`,
  );
  for (const child of node.children) assertCountsExact(child, where);
}

/** The rows' vertical order, which is the only place a wrong yoga index
 * shows up: yoga lays a column out in *its* order, not the child list's. */
const columnOrder = (pane) =>
  pane.children
    .filter((c) => c.yoga && !c.isWindow)
    .slice()
    .sort((a, b) => a.abs.y - b.abs.y)
    .map((c) => c.props.name);

/**
 * A pane of named rows in a column, rebuilt from `rows` on demand. The
 * trailing row is what everything is inserted in front of — the
 * after-spacer every virtualized list ends with, and the sibling whose
 * `indexOf` the old code re-scanned for every row of the batch.
 */
async function pane(initial, extras = () => []) {
  const app = createMockApp({ width: 200, height: 400 });
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  let setRows;
  function App() {
    const [rows, set] = React.useState(initial);
    setRows = set;
    return h(
      'window',
      { style: { width: 200, height: 400 } },
      h(
        'box',
        { ref, style: { flexDirection: 'column' } },
        ...extras(),
        ...rows.map((name) =>
          h('box', { key: name, name, style: { height: 4 } }),
        ),
        h('box', { key: 'tail', name: 'tail', style: { height: 4 } }),
      ),
    );
  }
  await new Promise((resolve) => x11Root.render(h(App), resolve));
  await settle();
  return {
    app,
    x11Root,
    node: ref.current,
    async set(rows) {
      setRows(rows);
      await settle();
    },
  };
}

const names = (n, prefix = 'r') =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// --- the shape of the cost ------------------------------------------------

/**
 * Mount `batch` rows into a pane that already holds `resident`, and count
 * what the pane was asked. `paintBounds` is patched on the instance, which
 * is where `_childListBefore` and the post-layout claim both go through.
 */
async function commitCost(resident, batch) {
  const p = await pane(names(resident));
  const node = p.node;
  let walks = 0;
  let scans = 0;
  const paintBounds = node.paintBounds.bind(node);
  node.paintBounds = () => {
    walks++;
    return paintBounds();
  };
  const indexOfChild = node._indexOfChild.bind(node);
  node._indexOfChild = (child) => {
    // a cache hit is proved by the slot, so anything else is a real scan
    if (node.children[child._childIndex] !== child) scans++;
    return indexOfChild(child);
  };
  await p.set([...names(resident), ...names(batch, 'b')]);
  assertCountsExact(node, `${resident}+${batch}`);
  await p.x11Root.unmount?.();
  p.app.close?.();
  return { walks, scans, children: node.children.length };
}

test('mounting a batch of rows asks the pane a fixed number of questions', async () => {
  const small = await commitCost(20, 40);
  const large = await commitCost(80, 40);

  assert.strictEqual(small.children, 61);
  assert.strictEqual(large.children, 121);

  // The point of the issue: four times the pane, the same commit. Before the
  // fix these were 40 walks and 120 scans either way — one set per row —
  // and each walk and each scan was itself proportional to the pane.
  assert.deepStrictEqual(
    { walks: small.walks, scans: small.scans },
    { walks: large.walks, scans: large.scans },
    'the cost of a 40-row commit does not follow the length of the pane',
  );
  assert.ok(
    large.walks <= 2,
    `the pane is walked once before the batch and once after layout, ` +
      `not ${large.walks} times`,
  );
  assert.strictEqual(
    large.scans,
    0,
    'and a run of inserts in front of the same sibling never scans the list',
  );
});

test('removing a batch of rows is amortized the same way', async () => {
  const p = await pane(names(60));
  const node = p.node;
  let walks = 0;
  const paintBounds = node.paintBounds.bind(node);
  node.paintBounds = () => {
    walks++;
    return paintBounds();
  };
  await p.set(names(10));
  assert.ok(walks <= 2, `${walks} walks for a 50-row removal`);
  assertCountsExact(node, 'after removal');
  assert.deepStrictEqual(columnOrder(node), [...names(10), 'tail']);
  await p.x11Root.unmount?.();
  p.app.close?.();
});

test('the walk is amortized across a frame, not across the pane’s life', async () => {
  // The window the reuse is sound in is one frame — after `flush()` the tree
  // has been laid out and painted, and the rect from before it says nothing
  // about what is on the surface now.
  const p = await pane(names(10));
  const node = p.node;
  const walks = [];
  let n = 0;
  const paintBounds = node.paintBounds.bind(node);
  node.paintBounds = () => {
    n++;
    return paintBounds();
  };
  for (const rows of [names(20), names(5), names(14)]) {
    n = 0;
    await p.set(rows);
    walks.push(n);
  }
  assert.ok(
    walks.every((w) => w >= 1),
    `each commit walks the pane again: ${walks.join(', ')}`,
  );
  await p.x11Root.unmount?.();
  p.app.close?.();
});

// --- the bookkeeping that replaced the scans ------------------------------

test('a keyed reorder still lands every row in its yoga slot', async () => {
  const p = await pane(names(6));
  const orders = [
    ['r5', 'r4', 'r3', 'r2', 'r1', 'r0'],
    ['r3', 'r0', 'r5', 'r1', 'r4', 'r2'],
    ['r2', 'r3', 'r4', 'r5', 'r0', 'r1'],
    // and one that inserts, moves and removes in the same commit
    ['r4', 'new', 'r1', 'r0'],
  ];
  for (const order of orders) {
    await p.set(order);
    assert.deepStrictEqual(
      p.node.children.map((c) => c.props.name),
      [...order, 'tail'],
      `child list after ${order.join(',')}`,
    );
    assert.deepStrictEqual(
      columnOrder(p.node),
      [...order, 'tail'],
      `laid-out order after ${order.join(',')}`,
    );
    assertCountsExact(p.node, order.join(','));
  }
  await p.x11Root.unmount?.();
  p.app.close?.();
});

test('a popup among the rows does not take a yoga slot', async () => {
  // A `<popup>` is its own window: it sits in the child list and outside the
  // parent's yoga tree, which is exactly the case the fast path in
  // `_yogaIndexAt` has to refuse.
  const p = await pane(names(4), () => [
    h('popup', { key: 'p', x: 0, y: 0, style: { width: 20, height: 20 } }),
  ]);
  assert.strictEqual(p.node._nonYogaKids, 1, 'the popup is counted as outside');
  assertCountsExact(p.node, 'with a popup');
  assert.deepStrictEqual(columnOrder(p.node), [...names(4), 'tail']);

  // …and a batch mounted in front of the trailing row still stacks in order
  await p.set(['r0', 'r1', 'r2', 'r3', ...names(20, 'b')]);
  assertCountsExact(p.node, 'with a popup, after a batch');
  assert.deepStrictEqual(columnOrder(p.node), [
    ...names(4),
    ...names(20, 'b'),
    'tail',
  ]);
  await p.x11Root.unmount?.();
  p.app.close?.();
});

test('text chunks are outside their parent’s yoga tree and counted so', async () => {
  const app = createMockApp({ width: 200, height: 200 });
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  let setLabel;
  function App() {
    const [label, set] = React.useState('one');
    setLabel = set;
    return h(
      'window',
      { style: { width: 200, height: 200 } },
      h(
        'box',
        { ref, style: { flexDirection: 'column' } },
        h('text', {}, label),
      ),
    );
  }
  await new Promise((resolve) => x11Root.render(h(App), resolve));
  await settle();
  assertCountsExact(ref.current, 'text mounted');
  setLabel('two');
  await settle();
  assertCountsExact(ref.current, 'text updated');
  await x11Root.unmount?.();
  app.close?.();
});

// --- that the amortized claim is safe -------------------------------------

const W = 160;
const H = 120;
const ROW_H = 6;

async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd });
}

const flushed = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

async function image(app, root) {
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const data = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );
  return Buffer.from(data.data);
}

test('a re-sliced window paints what a full repaint of it paints', async () => {
  // The invariant behind claiming the pane's bounds once instead of once per
  // insert: nothing is laid out or painted between two mutations of the same
  // frame, so the first walk already covers every pixel the later ones would
  // have.
  //
  // The pane here is deliberately *smaller* than the rows it holds and does
  // not clip them, which is what puts weight on that claim. A row that leaves
  // is gone before layout runs, so it is in no layout diff; and the
  // arrangement claimed after layout no longer reaches the band it occupied.
  // The pre-mutation walk is the only thing that erases it — and this commit
  // makes thirteen of them leave at once.
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    let setSlice;
    const paneRef = React.createRef();
    function App() {
      const [slice, set] = React.useState({ from: 0, count: 16 });
      setSlice = set;
      const rows = [];
      for (let i = 0; i < slice.count; i++) {
        const n = slice.from + i;
        rows.push(
          h('box', {
            key: n,
            style: {
              height: ROW_H,
              backgroundColor: n % 2 ? '#e74c3c' : '#2ecc71',
            },
          }),
        );
      }
      return h(
        'window',
        { width: W, height: H, style: { backgroundColor: '#101820' } },
        h(
          'box',
          { ref: paneRef, style: { flexDirection: 'column', height: 20 } },
          ...rows,
          h('box', {
            key: 'tail',
            style: { height: 4, backgroundColor: '#f1c40f' },
          }),
        ),
      );
    }
    await new Promise((resolve) => x11Root.render(h(App), resolve));
    await tick();
    const root = paneRef.current.root;
    root.flush();
    await flushed(app);

    // Each of these is one commit that mounts a batch of rows in front of the
    // trailing spacer and drops the ones that left — a scrollbar scrub's
    // re-slice, then one that lands near the end of a short list.
    for (const slice of [
      { from: 6, count: 14 },
      { from: 40, count: 3 },
      { from: 0, count: 16 },
    ]) {
      const where = `slice ${slice.from}+${slice.count}`;
      setSlice(slice);
      await settle();
      root.flush();
      await flushed(app);
      const amortized = await image(app, root);

      assert.ok(
        root._lastDamageRects,
        `${where}: the frame stayed bounded — a full repaint would prove ` +
          'nothing',
      );
      assertCountsExact(root, where);

      // the same tree again with the bound thrown away
      root.needsPaint = true;
      root._damage = null;
      root.flush();
      await flushed(app);
      const full = await image(app, root);

      assert.ok(
        amortized.equals(full),
        `${where}: one claim for the whole commit erases everything the ` +
          'commit moved',
      );
    }
  } finally {
    await x11Root.unmount?.();
    app.close?.();
  }
});
