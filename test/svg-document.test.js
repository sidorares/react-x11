// `<svg>` in children form: each element's props, serialized into the DOM
// ntk's SvgView parses. React commits every element of an `<svg>` it
// re-renders, each with a new props object, and the document used to be
// rebuilt on every one of those commits whatever changed: re-parsed, the
// `<svg>` re-measured and its box claimed before and after layout. A commit
// now rebuilds it only when the serialization changes.
//
// Claims are read off the window as they are made, as in
// test/ref-prop-damage.test.js: a commit that claims nothing schedules no
// frame, so the last frame's damage rects cannot answer for it.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { NO_DAMAGE } from '../src/nodes/damage.js';
import {
  cleanup,
  expectPixel,
  renderX11,
  settle,
} from '../src/testing/index.js';

const h = React.createElement;

afterEach(cleanup);

/** Every claim `windowNode` takes while `fn` runs. A node answering "nothing
 * I draw changed" still calls in, with `NO_DAMAGE`, and that call schedules
 * nothing, so it is not counted. `source` is the node that made a claim of
 * a rect. */
async function claimsDuring(windowNode, fn) {
  const claims = [];
  const invalidate = windowNode.invalidate;
  windowNode.invalidate = function (...args) {
    const [layoutChanged, damage, reason, source] = args;
    if (layoutChanged || damage !== NO_DAMAGE) {
      claims.push({ layoutChanged, damage, reason, source });
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
const label = ({ layoutChanged, damage, reason, source }) =>
  `${reason}${layoutChanged ? ' (layout)' : ''}: ` +
  (damage === null
    ? 'the whole window'
    : damage?.kind
      ? `<${damage.kind}>`
      : `${source?.kind ? `<${source.kind}> ` : ''}${JSON.stringify(damage)}`);

const SIZED = { width: 40, height: 16 };

test('an unchanged re-render of an <svg> with children claims nothing', async () => {
  let svg = null;
  // an inline style and an inline ref, new on every render, as a component
  // body writes them
  const Drawing = ({ r }) =>
    h(
      'svg',
      {
        viewBox: '0 0 10 10',
        style: { width: 40, height: 16 },
        ref: (node) => {
          if (node) svg = node;
        },
      },
      h('circle', { cx: 5, cy: 5, r }),
    );
  const { windowNode, rerender } = await renderX11(h(Drawing, { r: 4 }), {
    backend: 'mock',
  });
  const circle = svg.children[0];
  const mounted = { svg: svg.props, circle: circle.props };
  const revision = svg._docRevision;

  const claims = await claimsDuring(windowNode, () =>
    rerender(h(Drawing, { r: 4 })),
  );
  // the premise: React committed both elements again, because a commit it
  // skipped would claim nothing too
  assert.ok(svg.props !== mounted.svg, 'the <svg> was committed');
  assert.ok(circle.props !== mounted.circle, 'and so was its <circle>');
  assert.deepStrictEqual(claims.map(label), []);
  assert.strictEqual(svg._docRevision, revision, 'nothing was re-parsed');
  assert.strictEqual(svg._stale, false, 'or left for the next paint to');

  // …while a new attribute still claims the <svg>, and re-parses it
  const changed = await claimsDuring(windowNode, () =>
    rerender(h(Drawing, { r: 3 })),
  );
  assert.ok(
    changed.some((claim) => claim.layoutChanged && claim.source === svg),
    'a new r claims the <svg>, got ' +
      (changed.map(label).join(', ') || 'nothing'),
  );
  assert.ok(svg._docRevision > revision, 'and its document is rebuilt');
});

test('a source string written out again is not a change', async () => {
  // The other form: the document is the markup, rebuilt as a new string by
  // every render of a component that interpolates it.
  let svg = null;
  const Swatch = ({ fill }) =>
    h('svg', {
      source: `<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="${fill}"/></svg>`,
      style: SIZED,
      ref: (node) => {
        if (node) svg = node;
      },
    });
  const { windowNode, rerender } = await renderX11(
    h(Swatch, { fill: '#c0392b' }),
    { backend: 'mock' },
  );
  const mounted = svg.props;
  const revision = svg._docRevision;

  const claims = await claimsDuring(windowNode, () =>
    rerender(h(Swatch, { fill: '#c0392b' })),
  );
  assert.ok(svg.props !== mounted, 'the <svg> was committed');
  assert.deepStrictEqual(claims.map(label), []);
  assert.strictEqual(svg._docRevision, revision, 'nothing was re-parsed');

  const changed = await claimsDuring(windowNode, () =>
    rerender(h(Swatch, { fill: '#2980b9' })),
  );
  assert.ok(
    changed.some((claim) => claim.layoutChanged && claim.source === svg),
    'a new source claims the <svg>, got ' +
      (changed.map(label).join(', ') || 'nothing'),
  );
  assert.match(svg._docKey, /#2980b9/, 'and its document is the new one');
});

test('an attribute rebuilt equal is not a change', async () => {
  // A new array on every render, and a number handed over as its string.
  // Both serialize as they did, so the document has nothing to rebuild —
  // and the <circle> nothing to claim: it draws nothing of its own.
  let svg = null;
  const Drawing = ({ r }) =>
    h(
      'svg',
      {
        viewBox: '0 0 10 10',
        style: SIZED,
        ref: (node) => {
          if (node) svg = node;
        },
      },
      h('circle', { cx: 5, cy: 5, r, strokeDasharray: [2, 1] }),
    );
  const { windowNode, rerender } = await renderX11(h(Drawing, { r: 4 }), {
    backend: 'mock',
  });
  const circle = svg.children[0];
  const dashes = circle.props.strokeDasharray;
  const revision = svg._docRevision;

  const claims = await claimsDuring(windowNode, () =>
    rerender(h(Drawing, { r: '4' })),
  );
  assert.ok(
    circle.props.strokeDasharray !== dashes && circle.props.r === '4',
    'the <circle> was handed a new array and a string',
  );
  assert.deepStrictEqual(claims.map(label), []);
  assert.strictEqual(svg._docRevision, revision, 'nothing was re-parsed');
});

const W = 100;
const H = 80;

const readPixels = (ctx) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, image) =>
      err ? reject(err) : resolve(Buffer.from(image.data)),
    ),
  );

/** How many pixels two RGBA readbacks disagree on. */
function differences(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++;
  }
  return n;
}

test('a changed attribute repaints the drawing as a full repaint would', async () => {
  // Against the in-process X server, so these are real pixels. The 40x40
  // box scales the 10-unit viewBox by four: the circle is centred at 40,40,
  // with a radius of 16.
  let svg = null;
  const Scene = ({ viewBox = '0 0 10 10', r = 4, fill = '#c0392b' }) =>
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      h(
        'svg',
        {
          viewBox,
          style: { margin: 20, width: 40, height: 40 },
          ref: (node) => {
            if (node) svg = node;
          },
        },
        h('circle', { cx: 5, cy: 5, r, fill }),
      ),
    );
  const { app, ctx, windowNode, rerender } = await renderX11(h(Scene), {
    wrap: false,
  });
  await expectPixel(ctx, 40, 40, '#c0392b', { message: 'mounted' });

  /** Commit `props`, paint the frame the commit asked for, then a full
   * frame of the same tree, and hand back both readbacks. */
  const paintBothWays = async (props) => {
    const step = JSON.stringify(props);
    const revision = svg._docRevision;
    await rerender(h(Scene, props));
    assert.ok(svg._docRevision > revision, `${step} re-parsed the document`);
    const rects = windowNode._lastDamageRects;
    assert.ok(rects?.length > 0, `${step} painted a region, not the window`);
    const partial = await readPixels(ctx);

    windowNode.invalidate(true, null, 'expose');
    windowNode._scheduled = false;
    windowNode.flush();
    await settle(app);
    const full = await readPixels(ctx);
    assert.strictEqual(
      differences(partial, full),
      0,
      `the frame for ${step} differs from a full repaint`,
    );
  };

  // a child's paint: the only attribute that changed is on the <circle>
  await paintBothWays({ fill: '#2980b9' });
  await expectPixel(ctx, 40, 40, '#2980b9', { message: 'a new fill' });

  // …and its geometry, which has to take the old ring with it: 12 px above
  // the centre is inside a radius of 16 and outside one of 8
  await paintBothWays({ fill: '#2980b9', r: 2 });
  await expectPixel(ctx, 40, 28, '#ffffff', { message: 'the ring r=4 left' });
  await expectPixel(ctx, 40, 40, '#2980b9', { message: 'r=2' });

  // the <svg>'s own attribute: twice the viewBox halves the drawing, so the
  // circle moves to 30,30 with a radius of 4
  await paintBothWays({ fill: '#2980b9', r: 2, viewBox: '0 0 20 20' });
  await expectPixel(ctx, 30, 30, '#2980b9', { message: 'the new viewBox' });
  await expectPixel(ctx, 40, 40, '#ffffff', { message: 'where it was' });

  // an attribute taken away, which leaves the others as they were: the
  // circle falls back to SVG's default fill, black
  await paintBothWays({ fill: null, r: 2, viewBox: '0 0 20 20' });
  await expectPixel(ctx, 30, 30, '#000000', { message: 'no fill' });
});

test('an object ref on a child is not an attribute of the drawing', async () => {
  // Since React 19 a ref reaches the host element as an ordinary prop, and
  // an object ref is not a function for the serializer to skip.
  const ref = React.createRef();
  let svg = null;
  await renderX11(
    h(
      'svg',
      {
        viewBox: '0 0 10 10',
        style: SIZED,
        ref: (node) => {
          if (node) svg = node;
        },
      },
      h('circle', { ref, cx: 5, cy: 5, r: 4 }),
    ),
    { backend: 'mock' },
  );
  const circle = svg.children[0];
  assert.strictEqual(ref.current, circle, 'the ref is attached, to the node');

  // `_docKey` is the serialized document the paint cache keys on
  const dom = JSON.parse(svg._docKey);
  assert.deepStrictEqual(dom.children[0].attribs, {
    cx: '5',
    cy: '5',
    r: '4',
  });
  // …and neither is the <svg>'s style, which lays the element out
  assert.deepStrictEqual(dom.attribs, { viewBox: '0 0 10 10' });
});

test('a key in props would not be an attribute either', async () => {
  // React strips `key` before a host element sees it. This is the commit
  // with one left in, which is what a React that passed it on would make.
  let svg = null;
  await renderX11(
    h(
      'svg',
      {
        viewBox: '0 0 10 10',
        style: SIZED,
        ref: (node) => {
          if (node) svg = node;
        },
      },
      h('circle', { cx: 5, cy: 5, r: 4 }),
    ),
    { backend: 'mock' },
  );
  const circle = svg.children[0];
  const revision = svg._docRevision;
  circle.applyProps({ ...circle.props, key: 'c' }, circle.props);
  assert.deepStrictEqual(circle.toDom().attribs, { cx: '5', cy: '5', r: '4' });
  assert.strictEqual(svg._stale, false, 'and nothing is rebuilt for it');
  assert.strictEqual(svg._docRevision, revision);
});
