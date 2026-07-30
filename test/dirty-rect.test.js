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

import ReactX11 from '../src/index.js';

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

/**
 * Mount `element` and hand back the root WindowNode plus the refs given.
 * A ref is the way in: `getPublicInstance` returns the ntk window for
 * `<window>` but the node itself for everything else, and a node knows its
 * `root`.
 */
async function mount(app, element) {
  await new Promise((resolve) => ReactX11.render(element, resolve, app));
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
 * the same tree and compare. `damage` is the region the first frame used —
 * null when it repainted everything.
 */
async function paintBothWays(app, root, change) {
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const settle = () =>
    new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

  change();
  root.flush();
  await settle();
  const damage = root._lastDamage;
  const partial = await readPixels(ctx, W, H);

  root.needsPaint = true;
  root._damage = null;
  root.flush();
  await settle();
  const full = await readPixels(ctx, W, H);

  return { damage, partial, full, diff: differences(partial, full) };
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
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(app, rowsElement(refs));
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

test('two hovered rows accumulate into one region spanning both', async () => {
  const app = await headlessApp();
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(app, rowsElement(refs));
    const root = refs[0].current.root;

    const { damage, diff } = await paintBothWays(app, root, () => {
      refs[1].current.setStyleState(':hover', true);
      refs[6].current.setStyleState(':hover', true);
    });

    assert.ok(damage, 'two paint-only changes still bound the repaint');
    assert.ok(
      damage.height > 4 * ROW_H,
      `union should span rows 1..6, got height ${damage.height}`,
    );
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});

test('a caret repaint is bounded to the field it blinks in', async () => {
  const app = await headlessApp();
  try {
    const fieldRef = React.createRef();
    await mount(
      app,
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
      app,
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

test('a layout change is never painted partially', async () => {
  const app = await headlessApp();
  try {
    const refs = Array.from({ length: 8 }, () => React.createRef());
    await mount(app, rowsElement(refs));
    const row = refs[3].current;
    const root = row.root;

    // a height change moves every row below it, so the region the changed
    // node covers says nothing about where stale pixels are
    const { damage, diff } = await paintBothWays(app, root, () => {
      row.applyProps(
        { ...row.props, style: { ...HOISTED[3], height: 40 } },
        row.props,
      );
    });

    assert.equal(damage, null, 'a layout change repaints the whole window');
    assert.equal(diff, 0, `${diff} pixels differ from a full repaint`);
  } finally {
    await app.close();
  }
});
