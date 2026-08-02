// Partial repaints: a paint-only change repaints the region it affected
// instead of the whole window.
//
// The invariant that makes this safe is pixel equality — a partial repaint
// must leave the surface exactly as a full repaint of the same tree would.
// Every test here paints twice, once through the damage path and once with
// the damage discarded, and compares the readbacks byte for byte. A cull
// that drops something visible shows up as a diff.
//
// The changes are driven through the renderer's own paint-only entry points
// (`setStyleState` for a `:hover` block, `_repaint` for a caret) rather than
// through React state. That is not a shortcut: those are the paths that
// carry damage today, and they are synchronous, so `root.flush()` paints
// deterministically with no frame clock involved.
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

const W = 240;
const H = 200;
const ROW_H = 18;

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

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

// Wait for the server to work through everything sent so far. A test that
// closes the app with a paint still in flight gets "client is in closing
// state" out of the blit that follows it.
const settled = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

/**
 * Mount `element` and hand back the root WindowNode plus the refs given.
 * A ref is the way in: `getPublicInstance` returns the ntk window for
 * `<window>` but the node itself for everything else, and a node knows its
 * `root`.
 */
async function mount(x11Root, element) {
  await new Promise((resolve) => x11Root.render(element, resolve));
  await new Promise((r) => setImmediate(r));
}

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
 * Apply `change`, paint the frame it asked for, then paint a full frame of
 * the same tree and compare. `damage` is the box around the region the first
 * frame used and `rects` the rectangles it actually painted — both null when
 * it repainted everything.
 */
async function paintBothWays(app, root, change) {
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const settle = () =>
    new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

  change();
  root.flush();
  await settle();
  const damage = root._lastDamage;
  const rects = root._lastDamageRects;
  const partial = await readPixels(ctx, W, H);

  root.needsPaint = true;
  root._damage = null;
  root.flush();
  await settle();
  const full = await readPixels(ctx, W, H);

  return { damage, rects, partial, full, diff: differences(partial, full) };
}

// Styles are hoisted so a `:hover` block is the only thing that can change
// a row's paint, which is what the renderer resolves without a React render.
const rowStyle = (i) => ({
  height: ROW_H,
  backgroundColor: i % 2 ? '#ffffff' : '#e6e9ef',
  ':hover': { backgroundColor: '#ffd479' },
});
const HOISTED = Array.from({ length: 8 }, (_, i) => rowStyle(i));

function rowsElement(refs) {
  return React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: 6, gap: 3 } },
      HOISTED.map((style, i) =>
        React.createElement(
          'box',
          { key: i, ref: refs[i], style },
          React.createElement('text', { style: { fontSize: 10 } }, `row ${i}`),
        ),
      ),
    ),
  );
}

test('a hover state repaints only that row, with identical pixels', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const row = refs[4].current;
    const root = row.root;

    const { damage, diff } = await paintBothWays(app, root, () =>
      row.setStyleState(':hover', true),
    );

    assert.ok(damage, 'a paint-only state change bounds the repaint');
    // one row plus a pixel of slop on each side, not the window
    assert.ok(
      damage.height <= ROW_H + 4,
      `expected ~${ROW_H}px tall, got ${damage.height}`,
    );
    assert.ok(
      damage.width * damage.height < W * H * 0.25,
      `damage ${damage.width}x${damage.height} should be a fraction of ${W}x${H}`,
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

// --- damage is a list of rects, not the box around them --------------------
//
// Two changes far apart used to be claimed as the one rect containing both, so
// hovering the first and last row of a list repainted the list. They are now
// kept separate and painted in a pass each, and the rows between them are not
// touched at all. The list is capped and collapsed back to its box when
// splitting would not save enough to pay for the extra passes, so the common
// case — changes near each other — is unchanged.

test('two rows far apart are painted as two rects, not the box around them', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const root = refs[0].current.root;

    const { damage, rects, diff } = await paintBothWays(app, root, () => {
      refs[1].current.setStyleState(':hover', true);
      refs[6].current.setStyleState(':hover', true);
    });

    assert.ok(damage, 'two paint-only changes still bound the repaint');
    assert.equal(rects.length, 2, 'one rect per row, not one spanning both');
    for (const rect of rects) {
      assert.ok(
        rect.height <= ROW_H + 2 * SLOP,
        `each rect is one row tall, got ${rect.height}`,
      );
    }
    // the box around them spans rows 1..6; the rects together are a third of it
    assert.ok(
      damage.height > 4 * ROW_H,
      `the box should span rows 1..6, got height ${damage.height}`,
    );
    const painted = rects.reduce((sum, r) => sum + r.width * r.height, 0);
    assert.ok(
      painted < damage.width * damage.height * 0.5,
      `painted ${painted}px of a ${damage.width * damage.height}px box`,
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('the rows between two far-apart changes are not painted', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // The pixel comparisons cannot show this: repainting a row that did not
    // change produces the same pixels, just at a cost. So count the paints.
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const root = refs[0].current.root;

    const painted = new Set();
    for (const [i, ref] of refs.entries()) {
      const node = ref.current;
      const original = node.paint.bind(node);
      node.paint = (ctx) => {
        painted.add(i);
        return original(ctx);
      };
    }

    refs[1].current.setStyleState(':hover', true);
    refs[6].current.setStyleState(':hover', true);
    root.flush();
    await settled(app);

    assert.deepEqual(
      [...painted].sort(),
      [1, 6],
      'only the two changed rows should have painted',
    );
  } finally {
    await app.close();
  }
});

test('two rows near each other collapse into one rect', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const root = refs[0].current.root;

    // Adjacent rows: two rects of ~20px separated by a 3px gap describe 40px
    // of the 43px box around them, so a second pass would buy nothing.
    const { rects, diff } = await paintBothWays(app, root, () => {
      refs[3].current.setStyleState(':hover', true);
      refs[4].current.setStyleState(':hover', true);
    });

    assert.equal(rects.length, 1, 'not worth splitting');
    assert.ok(
      rects[0].height <= 2 * ROW_H + 3 + 2 * SLOP,
      `both rows and the gap, got ${rects[0].height}`,
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('overlapping claims are merged, so no node is painted twice', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // Two rects sharing area would put a node in the overlap through two
    // passes. That is invisible for opaque drawing and wrong for anything
    // translucent, which would blend over itself — so they have to merge.
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const root = refs[0].current.root;

    root.invalidate(false, { x: 20, y: 20, width: 60, height: 60 });
    root.invalidate(false, { x: 50, y: 50, width: 60, height: 60 });

    assert.equal(root._damage.length, 1, 'the two claims merged');
    assert.deepEqual(root._damage[0], { x: 20, y: 20, width: 90, height: 90 });
    root.flush(); // consume the frame these claims scheduled, before closing
    await settled(app);
  } finally {
    await app.close();
  }
});

test('the number of rects stays capped, however many rows change', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const root = refs[0].current.root;

    // every other row: more separate regions than the cap allows
    const { rects, diff } = await paintBothWays(app, root, () => {
      for (const i of [0, 2, 4, 6])
        refs[i].current.setStyleState(':hover', true);
      refs[7].current.setStyleState(':hover', true);
    });

    assert.ok(rects, 'still bounded');
    assert.ok(rects.length <= 4, `at most the cap, got ${rects.length}`);
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('a claim covering the window gives up the bound entirely', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const root = refs[0].current.root;

    const { damage, rects, diff } = await paintBothWays(app, root, () => {
      refs[2].current.setStyleState(':hover', true);
      root.invalidate(false, { x: -10, y: -10, width: W + 20, height: H + 20 });
    });

    assert.equal(damage, null, 'no point clipping to the whole window');
    assert.equal(rects, null);
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('a caret repaint is bounded to the field it blinks in', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const fieldRef = React.createRef();
    await mount(
      x11Root,
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 6, gap: 3 } },
          [
            ...HOISTED.slice(0, 4).map((style, i) =>
              React.createElement('box', { key: `r${i}`, style }),
            ),
            React.createElement('textinput', {
              key: 'field',
              ref: fieldRef,
              value: 'hello',
              style: { height: 22, backgroundColor: '#ffffff' },
            }),
          ],
        ),
      ),
    );
    const field = fieldRef.current;
    const root = field.root;

    const { damage, diff } = await paintBothWays(app, root, () =>
      field._repaint(),
    );

    assert.ok(damage, 'the caret bounds its own repaint');
    assert.ok(
      damage.height <= 22 + 4,
      `expected the field's height, got ${damage.height}`,
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('a subtree is culled by its whole extent, not its own rect', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // `host` is a 10x10 box at the top of the window whose absolutely
    // positioned child is drawn 120px lower, over `target`. Hovering
    // `target` damages only that strip — which `host`'s own rect misses
    // entirely, while its child sits right inside it. Culling the subtree on
    // the parent's rect alone therefore skips a node that had to repaint,
    // and the background fill has already erased it.
    const hostRef = React.createRef();
    const targetRef = React.createRef();
    await mount(
      x11Root,
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 6, gap: 3 } },
          [
            React.createElement('box', {
              key: 'target',
              ref: targetRef,
              style: {
                marginTop: 100,
                height: 40,
                backgroundColor: '#e6e9ef',
                ':hover': { backgroundColor: '#ffd479' },
              },
            }),
            // last in paint order, so its overflowing child lands *on top* of
            // target — otherwise target's opaque background hides it and a
            // dropped repaint leaves no trace to assert on
            React.createElement(
              'box',
              {
                key: 'host',
                ref: hostRef,
                style: {
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: 10,
                  height: 10,
                  backgroundColor: '#cccccc',
                },
              },
              React.createElement('box', {
                style: {
                  position: 'absolute',
                  left: 20,
                  top: 126,
                  width: 80,
                  height: 20,
                  backgroundColor: '#27ae60',
                },
              }),
            ),
          ],
        ),
      ),
    );
    const target = targetRef.current;
    const host = hostRef.current;

    // the premise: host's own rect must not touch the damaged strip, but its
    // subtree must — otherwise this test proves nothing
    const strip = target.paintBounds();
    assert.ok(
      !(
        host.abs.y < strip.y + strip.height &&
        strip.y < host.abs.y + host.abs.height
      ),
      `host at y=${host.abs.y}..${host.abs.y + host.abs.height} must miss the strip at y=${strip.y}..${strip.y + strip.height}`,
    );
    const extent = host._subtreeBounds();
    assert.ok(
      extent.y + extent.height > strip.y,
      'host subtree must reach into the damaged strip',
    );

    const { diff } = await paintBothWays(app, target.root, () =>
      target.setStyleState(':hover', true),
    );
    assert.equal(diff, 0, `overflowing child lost: ${diff} pixels differ`);
  } finally {
    await app.close();
  }
});

test('a layout change is bounded to what moved, pixel-exact', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(x11Root, rowsElement(refs));
    const row = refs[3].current;
    const root = row.root;

    // a height change moves every row below it: the changed row claims its
    // before/after subtree, and each displaced sibling claims its own old
    // and new rects through the layout diff — the rows above never repaint
    const { damage, diff } = await paintBothWays(app, root, () => {
      row.applyProps(
        { ...row.props, style: { ...HOISTED[3], height: 40 } },
        row.props,
      );
    });

    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    assert.ok(damage, 'a bounded layout change must not repaint the window');
    const row2Bottom = 6 + 2 * (ROW_H + 3) + ROW_H; // unmoved rows above
    assert.ok(
      damage.y >= row2Bottom,
      `damage starts at y=${damage.y}, repainting the unmoved rows above ` +
        `(row 2 ends at ${row2Bottom})`,
    );
    // both arrangements of the shifted rows: old row 7 ends at 171, and
    // after row 3 grows by 22 every later row sits 22 lower, so the grown
    // layout's row 7 ends at 193 — the bound must reach the deeper one
    const lastRowNewBottom = 6 + 7 * (ROW_H + 3) + ROW_H + (40 - ROW_H);
    assert.ok(
      damage.y + damage.height >= lastRowNewBottom,
      `damage ends at ${damage.y + damage.height}, short of the shifted ` +
        `rows (row 7 now ends at ${lastRowNewBottom})`,
    );
  } finally {
    await app.close();
  }
});

// --- React-driven updates --------------------------------------------------
//
// The cases above drive the renderer's own paint-only entry points. These go
// through React instead, which is harder: a commit calls applyProps on every
// node it walked, and React rebuilds sibling style objects on every render.
// Damage stays bounded only because a node whose drawing did not actually
// change contributes none.

/** Mount `body(state)` under a component and return a state setter. */
async function mountStateful(x11Root, body) {
  const ref = React.createRef();
  let setState;
  function App() {
    const [state, set] = React.useState(0);
    setState = set;
    return React.createElement(
      'window',
      { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
      React.createElement(
        'box',
        { ref, style: { flexGrow: 1, padding: 6, gap: 3 } },
        body(state),
      ),
    );
  }
  await new Promise((resolve) =>
    x11Root.render(React.createElement(App), resolve),
  );
  await new Promise((r) => setImmediate(r));
  return { root: ref.current.root, setState: (v) => setState(v) };
}

test('a React update bounds the repaint to the row that changed', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // styles built inline every render, the way an app really writes them:
    // all eight rows get a fresh style object, only one differs in value
    const { root, setState } = await mountStateful(x11Root, (state) =>
      Array.from({ length: 8 }, (_, i) =>
        React.createElement(
          'box',
          {
            key: i,
            style: {
              height: ROW_H,
              backgroundColor:
                i === 4 && state ? '#ffd479' : i % 2 ? '#ffffff' : '#e6e9ef',
            },
          },
          React.createElement('text', { style: { fontSize: 10 } }, `row ${i}`),
        ),
      ),
    );

    const ctx = (root._ctx ??= root.window.getContext('2d'));
    const settle = () =>
      new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

    setState(1);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      await settle();
    }
    root.flush();
    await settle();
    const damage = root._lastDamage;
    const partial = await readPixels(ctx, W, H);

    root.needsPaint = true;
    root._damage = null;
    root.flush();
    await settle();
    const full = await readPixels(ctx, W, H);
    const diff = differences(partial, full);

    assert.ok(damage, 'the commit did not widen the region to everything');
    assert.ok(
      damage.height <= ROW_H + 4,
      `one row expected, got ${damage.width}x${damage.height} — the seven ` +
        'rows whose style objects were rebuilt unchanged must contribute none',
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('a non-style prop the node paints from still damages it', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // Two things change in ONE commit: a row's colour, which bounds the
    // damage to a thin strip, and the field's `placeholder`, which is a prop
    // painted whenever the value is empty. TextInputNode's own applyProps
    // does not invalidate for `placeholder` — it only reacts to text metrics
    // and to `value` — so the base class has to notice the changed prop.
    //
    // Both halves are load-bearing. Changing the placeholder alone proves
    // nothing: with no node claiming damage the frame falls back to a full
    // repaint, which is correct by construction and hides the bug. It is
    // only when something *else* bounds the region that a node failing to
    // claim its own is left with stale pixels. <canvas> would not test this
    // either — CanvasNode invalidates unconditionally on any update.
    const fieldRef = React.createRef();
    let setState;
    function App() {
      const [state, set] = React.useState(0);
      setState = set;
      return React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#f5f6fa' } },
        React.createElement(
          'box',
          { style: { flexGrow: 1, padding: 6, gap: 3 } },
          [
            React.createElement('box', {
              key: 'row',
              style: {
                height: ROW_H,
                backgroundColor: state ? '#ffd479' : '#e6e9ef',
              },
            }),
            React.createElement('textinput', {
              key: 'field',
              ref: fieldRef,
              value: '',
              placeholder: state ? 'changed placeholder' : 'first',
              style: { height: 22, backgroundColor: '#ffffff' },
            }),
          ],
        ),
      );
    }
    await new Promise((resolve) =>
      x11Root.render(React.createElement(App), resolve),
    );
    await new Promise((r) => setImmediate(r));

    const root = fieldRef.current.root;
    const ctx = (root._ctx ??= root.window.getContext('2d'));
    const settle = () =>
      new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

    setState(1);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      await settle();
    }
    root.flush();
    await settle();
    const damage = root._lastDamage;
    const partial = await readPixels(ctx, W, H);

    root.needsPaint = true;
    root._damage = null;
    root.flush();
    await settle();
    const full = await readPixels(ctx, W, H);
    const diff = differences(partial, full);

    // the premise: the frame really was bounded, so a node that failed to
    // claim damage would have been culled
    assert.ok(
      damage,
      'the frame must be bounded for this test to mean anything',
    );
    assert.equal(
      diff,
      0,
      `the field kept its old placeholder: ${diff} pixels differ from a full repaint`,
    );
  } finally {
    await app.close();
  }
});

// --- frames that should not happen, and frames that must stay bounded ------
//
// Three ways a repaint used to escape its bounds, all found by hovering
// controls in examples/stress/ and watching the frame log say FULL WINDOW.
// None was visible to the tests above, because each needs a *second* commit
// after the tree has settled.

// Mirrors DAMAGE_SLOP in src/nodes.js: paintBounds inflates a claimed region
// by a pixel, so a node that inks slightly outside its rect is still covered.
const SLOP = 1;

/**
 * Record every frame that paints between now and when `act` has settled.
 *
 * Reading `_lastDamage` after the fact is not enough here: a scheduled frame
 * may have run during the wait, and for the animation case several will have.
 * Wrapping `flush` catches each one — including the animation frames, which
 * arrive with `needsPaint` still false because `_advanceAnimations` sets it
 * from inside flush.
 */
async function framesDuring(root, app, act, { rounds = 6, delay = 0 } = {}) {
  const settle = () =>
    new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  const regions = [];
  const original = root.flush.bind(root);
  root.flush = () => {
    const painting =
      root.needsPaint || root.needsLayout || root._animating.size > 0;
    const result = original();
    if (painting) regions.push(root._lastDamage);
    return result;
  };
  try {
    await act();
    for (let i = 0; i < rounds; i++) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      await new Promise((r) => setImmediate(r));
      await settle();
      root._scheduled = false;
      root.flush();
      await settle();
    }
  } finally {
    delete root.flush;
  }
  return regions;
}

test('a commit that changes nothing visible paints no frame at all', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // The state reaches no prop at all, so the re-render produces exactly the
    // tree already on screen — new element objects, so React really does walk
    // it and call applyProps on every node, but nothing to draw differently.
    // (State carried on *any* prop would not do: props are compared by
    // identity, so a changed one is a real claim, which is deliberate — that
    // is where a subclass's content lives.)
    const { root, setState } = await mountStateful(x11Root, () =>
      Array.from({ length: 6 }, (_, i) =>
        React.createElement(
          'box',
          {
            key: i,
            // a fresh style object every render, identical contents
            style: { height: ROW_H, backgroundColor: '#dfe6e9' },
          },
          React.createElement('text', { style: { fontSize: 10 } }, `row ${i}`),
        ),
      ),
    );

    const regions = await framesDuring(root, app, () => setState(1));
    assert.deepStrictEqual(
      regions,
      [],
      `an identical re-render painted ${regions.length} frame(s); it should ` +
        'paint none, and certainly not the whole window',
    );
  } finally {
    await app.close();
  }
});

test('a canvas whose onDraw changed repaints the canvas, not the window', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // onDraw matches /^on[A-Z]/, so the base class skips it as an event
    // handler and CanvasNode is the only thing that notices. It used to claim
    // damage unbounded, which made every re-render of a component that draws
    // through <canvas> — a Checkbox tick, a Select chevron — repaint the whole
    // window.
    const { root, setState } = await mountStateful(x11Root, (state) => [
      React.createElement('box', {
        key: 'filler',
        style: { height: ROW_H, backgroundColor: '#dfe6e9' },
      }),
      React.createElement('canvas', {
        key: 'c',
        // a new closure every render, the way a component body produces one
        onDraw: (ctx) => {
          ctx.fillStyle = state ? '#e17055' : '#0984e3';
          ctx.fillRect(0, 0, 12, 8);
        },
        style: { width: 12, height: 8 },
      }),
    ]);

    const regions = await framesDuring(root, app, () => setState(1));
    assert.strictEqual(regions.length, 1, 'exactly one repaint');
    const damage = regions[0];
    assert.ok(damage, 'the canvas repaint must be bounded, got FULL WINDOW');
    assert.ok(
      damage.width <= 12 + 2 * SLOP + 1 && damage.height <= 8 + 2 * SLOP + 1,
      `damage ${damage.width}x${damage.height} should be the canvas plus ` +
        'slop, not the window',
    );
  } finally {
    await app.close();
  }
});

test('an animated transition stays bounded, including its last frame', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // An absolutely-positioned thumb sliding on `left` is the Switch's
    // arrangement. Every frame of it used to repaint the whole window — and so
    // did the frame the animation *landed* on, because the node was dropped
    // from the animating set before anything claimed its region.
    const TRACK = { width: 36, height: 20 };
    const { root, setState } = await mountStateful(x11Root, (state) =>
      React.createElement(
        'box',
        {
          key: 'track',
          style: { ...TRACK, backgroundColor: '#dfe6e9' },
        },
        React.createElement('box', {
          key: 'thumb',
          style: {
            position: 'absolute',
            top: 2,
            left: state ? 18 : 2,
            width: 16,
            height: 16,
            backgroundColor: '#0984e3',
            transition: { left: 120 },
          },
        }),
      ),
    );

    // 120ms of animation: the rounds need real time between them, or the loop
    // spins through faster than the transition advances and never sees it land
    const regions = await framesDuring(root, app, () => setState(1), {
      rounds: 16,
      delay: 16,
    });

    assert.ok(
      regions.length >= 2,
      `the transition should span several frames, got ${regions.length}`,
    );
    const unbounded = regions.filter((r) => r === null).length;
    assert.strictEqual(
      unbounded,
      0,
      `${unbounded} of ${regions.length} animation frames repainted the ` +
        'whole window',
    );
    for (const r of regions) {
      assert.ok(
        r.width <= TRACK.width + 2 * SLOP + 1,
        `an animation frame claimed ${r.width}x${r.height}, wider than the ` +
          'track it slides inside',
      );
    }
    assert.strictEqual(root._animating.size, 0, 'the animation finished');
  } finally {
    await app.close();
  }
});

test('mounting a child inside a fixed-size box repaints only that box', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // A `Checkbox`'s tick and a `Radio`'s dot are children that mount and
    // unmount, and a child list change is a layout change — which with no
    // bound repaints the window. But when the container's own size is pinned
    // the reflow cannot move anything outside it, so the damage is that
    // subtree before the mutation unioned with the same subtree after layout.
    const WELL = 16;
    const { root, setState } = await mountStateful(x11Root, (state) => [
      React.createElement('box', {
        key: 'filler',
        style: { height: ROW_H, backgroundColor: '#dfe6e9' },
      }),
      React.createElement(
        'box',
        {
          key: 'well',
          style: {
            width: WELL,
            height: WELL,
            backgroundColor: '#ffffff',
            borderWidth: 1,
            borderColor: '#0984e3',
            alignItems: 'center',
            justifyContent: 'center',
          },
        },
        // the tick: present only when checked, exactly as Checkbox does it
        state
          ? React.createElement('box', {
              key: 'tick',
              style: { width: 8, height: 8, backgroundColor: '#0984e3' },
            })
          : null,
      ),
      React.createElement('box', {
        key: 'after',
        style: { height: ROW_H, backgroundColor: '#e6e9ef' },
      }),
    ]);

    const regions = await framesDuring(root, app, () => setState(1));
    assert.strictEqual(regions.length, 1, 'one repaint');
    const damage = regions[0];
    assert.ok(damage, 'mounting the tick must not repaint the whole window');
    assert.ok(
      damage.width <= WELL + 2 * SLOP + 1 &&
        damage.height <= WELL + 2 * SLOP + 1,
      `damage ${damage.width}x${damage.height} should be the ${WELL}px well ` +
        'plus slop',
    );
  } finally {
    await app.close();
  }
});

test('a child mounting in an auto-sized box stays bounded', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // A box with no pinned height grows when a child appears, which moves
    // its siblings — the box's own before/after claim cannot bound that,
    // but the displaced sibling claims itself through the layout diff, so
    // the frame stays the growth region instead of the whole window.
    const { root, setState } = await mountStateful(x11Root, (state) => [
      React.createElement(
        'box',
        { key: 'auto', style: { backgroundColor: '#ffffff' } },
        state
          ? React.createElement('box', {
              key: 'grown',
              style: { height: ROW_H, backgroundColor: '#0984e3' },
            })
          : null,
      ),
      React.createElement('box', {
        key: 'below',
        style: { height: ROW_H, backgroundColor: '#e6e9ef' },
      }),
    ]);

    const regions = await framesDuring(root, app, () => setState(1));
    assert.strictEqual(regions.length, 1, 'one repaint');
    const damage = regions[0];
    assert.ok(damage, 'the growth must not repaint the whole window');
    // the grown box plus the sibling it pushed down, in both arrangements:
    // everything ends well inside the top quarter of the window
    assert.ok(
      damage.y + damage.height >= 45 && damage.y + damage.height <= 50,
      `damage ends at ${damage.y + damage.height}, expected the pushed ` +
        'sibling to bound it near 46',
    );
    // and the bounded frame left exactly the pixels a full repaint would
    const ctx = (root._ctx ??= root.window.getContext('2d'));
    const settle = () =>
      new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
    const partial = await readPixels(ctx, W, H);
    root.needsPaint = true;
    root._damage = null;
    root.flush();
    await settle();
    const full = await readPixels(ctx, W, H);
    const diff = differences(partial, full);
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

/** Read pixels twice — after the bounded frame, and after forcing a full
 * repaint of the same tree — and return the damage box plus the diff. */
async function reactPaintBothWays(app, root, act) {
  const regions = await framesDuring(root, app, act);
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const settle = () =>
    new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  const partial = await readPixels(ctx, W, H);
  root.needsPaint = true;
  root._damage = null;
  root.flush();
  await settle();
  const full = await readPixels(ctx, W, H);
  return { regions, diff: differences(partial, full) };
}

test('an absolutely-positioned box moving stays a strip, pixel-exact', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // The animation case the bench pins (`update: 5 absolute box moves`):
    // `left` changes, layout runs, and the frame must be the box's old and
    // new rects — not the window. The damage box spans both positions
    // horizontally, so the vertical extent is what proves the bound.
    const { root, setState } = await mountStateful(x11Root, (state) =>
      React.createElement('box', {
        key: 'float',
        style: {
          position: 'absolute',
          left: 20 + state * 120,
          top: 40,
          width: 50,
          height: 50,
          backgroundColor: '#0984e3',
        },
      }),
    );
    const { regions, diff } = await reactPaintBothWays(app, root, () =>
      setState(1),
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    assert.strictEqual(regions.length, 1, 'one repaint');
    const damage = regions[0];
    assert.ok(damage, 'a moved absolute box must not repaint the window');
    assert.ok(
      damage.height <= 50 + 2 * SLOP + 2,
      `damage is ${damage.height}px tall for a 50px box`,
    );
  } finally {
    await app.close();
  }
});

test('a text change repaints the text line, pixel-exact', async () => {
  const app = await headlessApp();
  const x11Root = await createRoot({ app });
  try {
    // The ticking-label case: a new string rewraps inside the <text> box,
    // whose before/after claim bounds the frame. The block below it must
    // not repaint — its rect is unchanged, so the layout diff stays quiet.
    const { root, setState } = await mountStateful(x11Root, (state) => [
      React.createElement(
        'text',
        { key: 't', style: { fontSize: 12 } },
        `tick ${state}`,
      ),
      React.createElement('box', {
        key: 'b',
        style: { height: ROW_H, backgroundColor: '#e6e9ef', marginTop: 60 },
      }),
    ]);
    const { regions, diff } = await reactPaintBothWays(app, root, () =>
      setState(1),
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
    assert.strictEqual(regions.length, 1, 'one repaint');
    const damage = regions[0];
    assert.ok(damage, 'a text change must not repaint the window');
    assert.ok(
      damage.y + damage.height < 60,
      `damage reaches y=${damage.y + damage.height}, into the unmoved ` +
        'block that starts 60px down',
    );
  } finally {
    await app.close();
  }
});
