// The damage seam an element that draws a *scene* needs (issue #301).
//
// Core's damage machinery already coalesces claims into disjoint rects,
// paints one clipped pass per rect, and culls whole subtrees against the one
// being painted. Its granularity is the retained node — which is exactly
// right until the node *is* the whole pane, as it is for a graph view, a
// chart or an editor that draws its content rather than laying it out. Both
// ends of that conversation are opened here:
//
//  - `paintDamage()` — the rect the pass being painted covers, so the
//    element can cull its own drawing the way core culls the tree;
//  - `selfDamagedProps` and the `paintChanged` it feeds — a commit that
//    changes a prop whose damage the element has already claimed itself
//    contributes none of its own, instead of widening the frame to the
//    whole pane over the top of the scoped claim.
//
// The pixel test below is the one that matters. Everything else here asserts
// what an element is *told*; that one asserts that acting on it is safe — a
// rect handed out that is not exactly the pass's clip shows up as a cell the
// culling wrongly dropped, and the two readbacks stop being identical.
import assert from 'node:assert';
import { test, afterEach } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import { renderX11, cleanup, screen } from '../src/testing/index.js';

const h = React.createElement;

const W = 200;
const H = 120;

const registered = new Set();
function register(type, definition) {
  registerElement(type, definition);
  registered.add(type);
}

afterEach(async () => {
  await cleanup();
  for (const type of registered) unregisterElement(type);
  registered.clear();
});

/**
 * An element that draws a scene into one node: a grid of coloured cells,
 * each culled against the pass's rect. `passes` records what every paint was
 * told, and `drawn` how many cells that paint actually emitted — the number
 * the issue is about.
 */
class SceneNode extends Node {
  constructor(props, app) {
    super('scene', props, app);
    this.passes = [];
    this.drawn = [];
  }

  cells() {
    const cols = this.props.cols ?? 4;
    const rows = this.props.rows ?? 3;
    const { x, y, width, height } = this.abs;
    const cw = width / cols;
    const ch = height / rows;
    const out = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        out.push({
          x: x + col * cw,
          y: y + row * ch,
          width: cw,
          height: ch,
          color: this.props.colors?.[row * cols + col] ?? '#3498db',
        });
      }
    }
    return out;
  }

  paint(ctx) {
    super.paint(ctx);
    const damage = this.paintDamage();
    this.passes.push(damage);
    let drawn = 0;
    for (const cell of this.cells()) {
      // the cull the seam exists for: a cell the pass cannot show is a cell
      // whose requests never go on the wire
      if (damage && !overlaps(cell, damage)) continue;
      ctx.fillStyle = cell.color;
      ctx.fillRect(cell.x, cell.y, cell.width, cell.height);
      drawn++;
    }
    this.drawn.push(drawn);
  }
}

const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

// --- what the element is told --------------------------------------------

async function mountScene(props = {}) {
  await renderX11(h('scene', { style: { flexGrow: 1 }, ...props }), {
    backend: 'mock',
    width: W,
    height: H,
  });
  const node = screen.all((n) => n.kind === 'scene')[0];
  node.passes.length = 0;
  node.drawn.length = 0;
  return node;
}

test('paintDamage() is the rect of the pass being painted (#301)', async () => {
  register('scene', { create: (p, a) => new SceneNode(p, a) });
  const node = await mountScene();
  const root = node.root;

  assert.strictEqual(
    node.paintDamage(),
    null,
    'outside a paint nothing bounds you, which reads the same as a full pass',
  );

  node.invalidate(false, { x: 10, y: 10, width: 30, height: 20 }, 'props');
  root.flush();
  assert.deepStrictEqual(
    node.passes,
    [{ x: 10, y: 10, width: 30, height: 20 }],
    'one pass, told exactly the rect the frame clipped to',
  );
  assert.strictEqual(
    node.paintDamage(),
    null,
    'and it is null again the moment the pass is over',
  );

  // 4x3 cells of 50x40 over the pane: the claim lands inside one of them
  assert.deepStrictEqual(node.drawn, [1], 'the other eleven never drew');
});

test('one pass per damage rect, each with its own bound', async () => {
  register('scene', { create: (p, a) => new SceneNode(p, a) });
  const node = await mountScene();
  const root = node.root;

  // far apart, so the frame keeps them as two passes rather than merging
  // into the box around them (damageToPaint's area test)
  node.invalidate(false, { x: 4, y: 4, width: 20, height: 20 }, 'props');
  node.invalidate(false, { x: 170, y: 90, width: 20, height: 20 }, 'props');
  root.flush();

  assert.deepStrictEqual(node.passes, [
    { x: 4, y: 4, width: 20, height: 20 },
    { x: 170, y: 90, width: 20, height: 20 },
  ]);
  assert.deepStrictEqual(node.drawn, [1, 1], 'one cell per pass');
});

test('an unbounded frame says so with null, and the element draws it all', async () => {
  register('scene', { create: (p, a) => new SceneNode(p, a) });
  const node = await mountScene();
  const root = node.root;

  node.invalidate(false, null, 'props');
  root.flush();

  assert.deepStrictEqual(node.passes, [null], 'no bound is null, not a rect');
  assert.deepStrictEqual(node.drawn, [12], 'so every cell is drawn');
});

// --- that acting on it is safe -------------------------------------------

async function headlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd });
}

const settle = (app) =>
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

test('a cull against paintDamage() paints what a full repaint paints', async () => {
  register('scene', { create: (p, a) => new SceneNode(p, a) });
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const colors = Array.from({ length: 12 }, (_, i) =>
      i % 2 ? '#e74c3c' : '#2ecc71',
    );
    await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#101820' } },
          h('scene', { ref, colors, style: { flexGrow: 1 } }),
        ),
        resolve,
      ),
    );
    await new Promise((r) => setImmediate(r));
    const node = ref.current;
    const root = node.root;
    root.flush();
    await settle(app);

    // the drag step: one cell changes colour, and the element claims exactly
    // that cell — the scoped invalidate the whole seam is for
    const cell = node.cells()[6];
    node.props.colors[6] = '#f1c40f';
    node.passes.length = 0;
    node.drawn.length = 0;
    node.invalidate(false, cell, 'props');
    root.flush();
    await settle(app);
    const partial = await image(app, root);

    assert.ok(node.passes[0], 'the frame was bounded');
    assert.deepStrictEqual(
      node.drawn,
      [1],
      'and the element drew one cell, not twelve',
    );

    // the same tree again with the bound thrown away
    root.needsPaint = true;
    root._damage = null;
    root.flush();
    await settle(app);
    const full = await image(app, root);

    assert.deepStrictEqual(node.passes[1], null, 'the second frame was full');
    assert.deepStrictEqual(node.drawn[1], 12);
    assert.ok(
      partial.equals(full),
      'a pass the element culled against is pixel-identical to a full one',
    );
  } finally {
    await x11Root.unmount?.();
    app.close?.();
  }
});

// --- the commit side ------------------------------------------------------

/**
 * What the commit half is asked, without a frame clock in the way: reset the
 * window's bookkeeping, hand the node a props update the way the reconciler
 * does, and read back what it claimed.
 */
function commit(node, next) {
  const root = node.root;
  root.needsPaint = false;
  root._damage = null;
  const prev = node.props;
  node.applyProps({ ...prev, ...next }, prev);
  return { needsPaint: root.needsPaint, damage: root._damage };
}

test('selfDamagedProps: a claimed prop contributes no damage of its own', async () => {
  register('scene', {
    create: (p, a) => new SceneNode(p, a),
    selfDamagedProps: ['colors'],
  });
  const node = await mountScene({ colors: ['#111111'] });

  assert.deepStrictEqual(
    [...node.selfDamagedProps],
    ['colors'],
    'the declaration reaches the node',
  );

  // a controlled scene rebuilds this array every commit; the element's own
  // applyProps is what claims the box that moved
  const claimed = commit(node, { colors: ['#222222'] });
  assert.deepStrictEqual(
    claimed,
    { needsPaint: false, damage: null },
    'no frame is owed by the commit at all',
  );

  // and everything else keeps core's conservative answer
  const other = commit(node, { 'aria-label': 'graph' });
  assert.strictEqual(other.needsPaint, true);
  assert.deepStrictEqual(
    other.damage,
    [node.paintBounds()],
    'a prop the element said nothing about still damages the node',
  );
});

test('a style change is core’s answer, not the element’s to excuse', async () => {
  register('scene', {
    create: (p, a) => new SceneNode(p, a),
    // even a wildly over-claiming element
    selfDamagedProps: ['colors', 'style'],
  });
  const node = await mountScene({ colors: ['#111111'] });

  const restyled = commit(node, {
    colors: ['#222222'],
    style: { flexGrow: 1, backgroundColor: '#ff00ff' },
  });
  assert.strictEqual(
    restyled.needsPaint,
    true,
    'the background, the border and the clip are drawn by core',
  );
  assert.deepStrictEqual(restyled.damage, [node.paintBounds()]);
});

test('paintChanged: the override form, for an answer only the values give', async () => {
  // The <Flow> shape: a new `nodes` array every drag step, whose damage the
  // element claims itself *when the change is only positions*. Anything else
  // — a node added, a label edited — falls through to core.
  class FlowNode extends SceneNode {
    paintChanged(next, prev) {
      if (
        next.nodes !== prev.nodes &&
        samePositionsOnly(next.nodes, prev.nodes)
      )
        return false;
      return super.paintChanged(next, prev);
    }
  }
  const samePositionsOnly = (next, prev) =>
    Array.isArray(next) &&
    Array.isArray(prev) &&
    next.length === prev.length &&
    next.every((n, i) => n.id === prev[i].id && n.label === prev[i].label);

  register('scene', { create: (p, a) => new FlowNode(p, a) });
  const nodes = [{ id: 'a', label: 'A', x: 0 }];
  const node = await mountScene({ nodes });

  const moved = commit(node, { nodes: [{ id: 'a', label: 'A', x: 40 }] });
  assert.deepStrictEqual(
    moved,
    { needsPaint: false, damage: null },
    'a position-only step is the element’s own claim and nothing else',
  );

  const relabelled = commit(node, { nodes: [{ id: 'a', label: 'B', x: 40 }] });
  assert.strictEqual(
    relabelled.needsPaint,
    true,
    'anything the override does not recognise reaches super',
  );

  const other = commit(node, { title: 'graph' });
  assert.strictEqual(other.needsPaint, true, 'and so does every other prop');
});

test('the declaration is per registration, and leaves with it', async () => {
  register('scene', {
    create: (p, a) => new SceneNode(p, a),
    selfDamagedProps: ['colors'],
  });
  const node = await mountScene({ colors: ['#111111'] });
  assert.strictEqual(node.selfDamagedProps.has('colors'), true);
  assert.strictEqual(commit(node, { colors: ['#222222'] }).needsPaint, false);

  // re-registering must not leave the previous definition's claims behind
  register('scene', { create: (p, a) => new SceneNode(p, a), override: true });
  assert.strictEqual(node.selfDamagedProps.size, 0);
  assert.strictEqual(
    commit(node, { colors: ['#222222'] }).needsPaint,
    true,
    'and the conservative answer is back',
  );

  register('scene', {
    create: (p, a) => new SceneNode(p, a),
    selfDamagedProps: ['colors'],
    override: true,
  });
  unregisterElement('scene');
  registered.delete('scene');
  assert.strictEqual(node.selfDamagedProps.size, 0);
});
