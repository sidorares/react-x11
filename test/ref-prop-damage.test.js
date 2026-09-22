// A `ref` is React's, not the element's. Since React 19 a ref is an
// ordinary prop: `commitUpdate` hands it over with every other one, and an
// inline callback — `ref={(node) => …}`, the way a component body usually
// writes one — is a new function on every render. `paintChanged` compared it
// like a prop the element draws from, so a component that re-rendered with
// nothing else changed claimed the element's whole paint bounds every time:
// a scroll pane (found writing a `<glarea>` overlay test for #644), every tab
// of a `<Tabs>` strip, every title of a menu bar on each hover.
//
// The claims are read off the window as they are made, not off the frame
// that follows: a commit that claims nothing schedules no frame at all, so
// `_lastDamageRects` would still hold the previous frame's answer.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { Tabs } from '../src/index.js';
import { NO_DAMAGE } from '../src/nodes/damage.js';
import { cleanup, renderX11, screen } from '../src/testing/index.js';

const h = React.createElement;

afterEach(cleanup);

/**
 * Every claim `windowNode` takes while `fn` runs. A node answering "nothing
 * I draw changed" still calls in, with `NO_DAMAGE`, and that call schedules
 * nothing, so it is not counted.
 */
async function claimsDuring(windowNode, fn) {
  const claims = [];
  const invalidate = windowNode.invalidate;
  windowNode.invalidate = function (...args) {
    const [layoutChanged, damage, reason] = args;
    if (layoutChanged || damage !== NO_DAMAGE) {
      claims.push({ layoutChanged, damage, reason });
    }
    return invalidate.apply(this, args);
  };
  try {
    await fn();
  } finally {
    delete windowNode.invalidate;
  }
  return claims;
}

/** A claim as a string, since an assertion message must never inspect a
 * node. */
const label = ({ layoutChanged, damage, reason }) =>
  `${reason}${layoutChanged ? ' (layout)' : ''}: ` +
  (damage === null
    ? 'the whole window'
    : damage?.kind
      ? `<${damage.kind}>`
      : JSON.stringify(damage));

// Hoisted, so the ref is the only prop a re-render hands over new.
const ROWS = Array.from({ length: 30 }, (_, i) => i);
const SIZED = { width: 40, height: 16 };
const FIELD = { width: 120, height: 24 };
const DRAW = (ctx) => ctx.fillRect(0, 0, 4, 4);

test('a new inline ref callback is not a paint change', async () => {
  // The scroll pane it was found on, re-rendered with every prop the same
  // but the callback.
  let pane = null;
  const Pane = ({ thumb }) =>
    h(
      'box',
      {
        ref: (node) => {
          if (node) pane = node;
        },
        scrollbarColor: thumb,
        style: { flexGrow: 1, overflow: 'scroll' },
      },
      ROWS.map((i) => h('box', { key: i, style: { height: 20 } })),
    );
  const { windowNode, rerender } = await renderX11(
    h(Pane, { thumb: 'transparent' }),
    { backend: 'mock', width: 200, height: 120 },
  );
  const mounted = pane.props.ref;

  const claims = await claimsDuring(windowNode, () =>
    rerender(h(Pane, { thumb: 'transparent' })),
  );
  // the premise: the commit reached the pane and carried the new callback
  // in its props, because a commit React skipped would claim nothing too
  assert.ok(pane.props.ref !== mounted, 'the pane was handed a new ref');
  assert.deepStrictEqual(
    claims.map(label),
    [],
    'a commit that changed only the ref claims nothing',
  );

  // …while a prop the pane paints from still claims it on the same path
  const repainted = await claimsDuring(windowNode, () =>
    rerender(h(Pane, { thumb: '#e17055' })),
  );
  assert.ok(
    repainted.some((claim) => claim.damage === pane),
    'a new scrollbarColor claims the pane, got ' +
      (repainted.map(label).join(', ') || 'nothing'),
  );
});

test('no drawn element counts a new ref as a paint change', async () => {
  // Every element whose commit reaches `Node.paintChanged`, including those
  // that diff some props themselves: `<image>` its source, `<canvas>` its
  // `onDraw`, the two fields their `value`. A `<glarea>` asks its surface
  // for a new frame on any commit, which is not a claim on the window.
  // `<svg>` diffs the serialization of its document
  // (test/svg-document.test.js).
  const CASES = [
    ['box', { style: SIZED }],
    ['text', {}, 'label'],
    ['image', { style: SIZED }],
    ['canvas', { onDraw: DRAW, style: SIZED }],
    ['textinput', { value: 'abc', style: FIELD }],
    ['textarea', { value: 'abc', style: FIELD }],
    ['glarea', { style: SIZED }],
    ['foreign', { style: SIZED }],
    [
      'svg',
      { viewBox: '0 0 10 10', style: SIZED },
      h('circle', { cx: 5, cy: 5, r: 4 }),
    ],
  ];
  const nodes = new Map();
  const Sweep = () =>
    h(
      'box',
      { style: { flexGrow: 1, gap: 4 } },
      CASES.map(([kind, props, children]) =>
        h(
          kind,
          {
            key: kind,
            ...props,
            ref: (node) => {
              if (node) nodes.set(kind, node);
            },
          },
          children,
        ),
      ),
    );
  const { windowNode, rerender } = await renderX11(h(Sweep), {
    backend: 'mock',
    width: 200,
    height: 200,
  });
  const mounted = new Map(
    [...nodes].map(([kind, node]) => [kind, node.props.ref]),
  );

  const claims = await claimsDuring(windowNode, () => rerender(h(Sweep)));
  assert.deepStrictEqual(
    CASES.map(([kind]) => kind).filter(
      (kind) => nodes.get(kind).props.ref === mounted.get(kind),
    ),
    [],
    'every element was handed a new ref',
  );
  assert.deepStrictEqual(claims.map(label), []);
});

test('a Tabs strip re-rendered unchanged claims nothing', async () => {
  // A shipped component with one: each tab registers itself through an
  // inline ref, so a re-render of the strip, for a focus moving or a parent
  // rendering, claimed every tab in it.
  const items = ['Alpha', 'Beta', 'Gamma'].map((name) => ({
    id: name,
    label: name,
    content: h('box', null),
  }));
  const { windowNode, rerender } = await renderX11(h(Tabs, { items }), {
    backend: 'mock',
    width: 300,
    height: 120,
  });
  assert.strictEqual(screen.all((node) => node.props.role === 'tab').length, 3);

  const claims = await claimsDuring(windowNode, () =>
    rerender(h(Tabs, { items })),
  );
  assert.deepStrictEqual(claims.map(label), []);
});

test('a key in props would not be a paint change either', async () => {
  // React strips `key` before a host instance sees it. This is the
  // reconciler's call with one left in, which is what a React that stopped
  // stripping a spread key would make.
  let box = null;
  const { windowNode } = await renderX11(
    h('box', {
      ref: (node) => {
        if (node) box = node;
      },
      style: SIZED,
    }),
    { backend: 'mock' },
  );

  const claims = await claimsDuring(windowNode, async () => {
    const prev = box.props;
    box.applyProps({ ...prev, key: 'b' }, prev);
  });
  assert.deepStrictEqual(claims.map(label), []);
});
