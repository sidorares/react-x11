// registerElement() and the subpath exports third parties need (#125).
// Everything here imports through the published subpaths, because the point
// of the issue is that a package outside react-x11 can do this — a test
// reaching into src/ would prove nothing.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  registerElement,
  unregisterElement,
  registeredElements,
  hostTypes,
  knownElements,
  drawnKinds,
} from '../src/host.js';
import { Node } from '../src/node.js';
import { isStyleProp, flattenStyle } from '../src/style.js';
import { renderX11, cleanup, screen } from '../src/testing/index.js';

const h = React.createElement;

/**
 * Assert that mounting throws, without React's report of the escaping error
 * on stderr — several tests here fail on purpose, and the message under
 * test is the one thrown, not the one React logs about it. Same shape as
 * the console capture in handler-errors.test.js.
 */
async function rejectsQuietly(fn, expected) {
  const origError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(fn, expected);
  } finally {
    console.error = origError;
  }
}

/** A minimal third-party element: draws a polyline from `data`, and owns
 * `color` — a name the style vocabulary also has, which is exactly the
 * case that needs `semanticNames`. */
class SparklineNode extends Node {
  constructor(props, app) {
    super('sparkline', props, app);
    this.painted = 0;
  }

  paint(ctx) {
    super.paint(ctx);
    this.painted++;
    this.lastData = this.props.data;
    ctx.save?.();
    ctx.beginPath?.();
    const { x, y, width, height } = this.abs;
    const data = this.props.data ?? [];
    const max = Math.max(1, ...data);
    data.forEach((value, i) => {
      const px = x + (width * i) / Math.max(1, data.length - 1);
      const py = y + height - (height * value) / max;
      if (i === 0) ctx.moveTo?.(px, py);
      else ctx.lineTo?.(px, py);
    });
    ctx.strokeStyle = this.props.color ?? '#000';
    ctx.stroke?.();
    ctx.restore?.();
  }
}

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

test('a registered element mounts, lays out and paints', async () => {
  register('sparkline', {
    create: (props, app) => new SparklineNode(props, app),
    semanticNames: ['data', 'color'],
  });

  await renderX11(
    h('sparkline', {
      data: [1, 4, 2, 8],
      color: '#c0392b',
      style: { width: 120, height: 40, margin: 10 },
    }),
    { backend: 'mock' },
  );

  const node = screen.all((n) => n.kind === 'sparkline')[0];
  assert.ok(node, 'the element is in the retained tree');
  // yoga laid it out — the proof it joined DRAWN_KINDS rather than being
  // silently skipped by paintOrder
  assert.strictEqual(node.abs.width, 120);
  assert.strictEqual(node.abs.height, 40);
  assert.strictEqual(node.abs.x, 10);
  assert.ok(node.painted > 0, 'paint() ran');
  assert.deepStrictEqual(node.lastData, [1, 4, 2, 8]);
});

test('semanticNames exempts the element vocabulary from the DEV style assertion', async () => {
  // `color` is a style property, so without semanticNames this throws in
  // development and works in production — the dev/prod split #125 calls out
  assert.strictEqual(isStyleProp('color'), true, 'precondition');

  register('sparkline', {
    create: (props, app) => new SparklineNode(props, app),
    semanticNames: ['data', 'color'],
  });
  await renderX11(h('sparkline', { data: [1], color: 'red' }), {
    backend: 'mock',
  });
  screen.all((n) => n.kind === 'sparkline');

  // and an element that did NOT declare it still gets the assertion
  register('bare', { create: (props, app) => new Node('bare', props, app) });
  await rejectsQuietly(
    () => renderX11(h('bare', { color: 'red' }), { backend: 'mock' }),
    /<bare color=…> is a style property/,
  );
});

test('props update through the normal commit path', async () => {
  register('sparkline', {
    create: (props, app) => new SparklineNode(props, app),
    semanticNames: ['data', 'color'],
  });
  const { rerender } = await renderX11(
    h('sparkline', { data: [1, 2], style: { width: 50, height: 20 } }),
    { backend: 'mock' },
  );
  const node = screen.all((n) => n.kind === 'sparkline')[0];
  const before = node.painted;

  await rerender(
    h('sparkline', { data: [3, 4, 5], style: { width: 50, height: 20 } }),
  );
  assert.deepStrictEqual(node.props.data, [3, 4, 5]);
  assert.ok(node.painted > before, 'the update repainted');
});

test('drawn: false keeps the element out of paint order', async () => {
  class OffscreenNode extends Node {
    constructor(props, app) {
      super('offscreen', props, app);
    }
  }
  register('offscreen', {
    create: (props, app) => new OffscreenNode(props, app),
    drawn: false,
  });

  assert.ok(!drawnKinds().includes('offscreen'));
  await renderX11(h('box', { style: { flexGrow: 1 } }, h('offscreen', null)), {
    backend: 'mock',
  });
  const box = screen.all((n) => n.kind === 'box')[0];
  assert.ok(
    !box.paintOrder().some((n) => n.kind === 'offscreen'),
    'not painted by its parent',
  );
});

test('childrenAllowed: false says so instead of laying out a child', async () => {
  register('leafonly', {
    create: (props, app) => new Node('leafonly', props, app),
    childrenAllowed: false,
  });
  await rejectsQuietly(
    () => renderX11(h('leafonly', null, h('box', null)), { backend: 'mock' }),
    /<leafonly> takes no children[\s\S]*<box> is inside it/,
  );
});

test('the registry refuses names that could not work, and silent clashes', () => {
  assert.throws(
    () => registerElement('Sparkline', { create: () => null }),
    /JSX only treats lowercase names as host elements/,
  );
  assert.throws(
    () => registerElement('textchunk', { create: () => null }),
    /internal to react-x11/,
  );
  assert.throws(
    () => registerElement('thing', {}),
    /needs a create\(props, app\) function/,
  );

  register('dup', { create: (p, a) => new Node('dup', p, a) });
  assert.throws(
    () => registerElement('dup', { create: (p, a) => new Node('dup', p, a) }),
    /already registered[\s\S]*override: true/,
  );
  // deliberate replacement is allowed
  registerElement('dup', {
    create: (p, a) => new Node('dup', p, a),
    override: true,
  });
});

test('a create() that returns the wrong thing is caught at the source', async () => {
  register('wrong', { create: () => ({ kind: 'wrong' }) });
  await rejectsQuietly(
    () => renderX11(h('wrong', null), { backend: 'mock' }),
    /must return a Node/,
  );

  register('mislabelled', {
    create: (p, a) => new Node('somethingelse', p, a),
  });
  await rejectsQuietly(
    () => renderX11(h('mislabelled', null), { backend: 'mock' }),
    /returned a node of kind "somethingelse"/,
  );
});

test('an unknown element still errors, and now points at the registry', async () => {
  register('sparkline', { create: (p, a) => new SparklineNode(p, a) });
  await rejectsQuietly(
    () => renderX11(h('nosuchthing', null), { backend: 'mock' }),
    /unknown element type <nosuchthing>[\s\S]*registered: <sparkline>[\s\S]*registerElement\(\) from react-x11\/host/,
  );
});

test('the introspection helpers are copies, not the live sets', () => {
  const before = hostTypes();
  before.push('nonsense');
  assert.ok(!hostTypes().includes('nonsense'), 'hostTypes() copies');

  register('sparkline', { create: (p, a) => new SparklineNode(p, a) });
  assert.deepStrictEqual(registeredElements(), ['sparkline']);
  assert.ok(knownElements().includes('box'), 'built-ins');
  assert.ok(knownElements().includes('sparkline'), 'and registered ones');
  assert.ok(drawnKinds().includes('sparkline'), 'drawn by default');

  unregisterElement('sparkline');
  registered.delete('sparkline');
  assert.deepStrictEqual(registeredElements(), []);
  assert.ok(!drawnKinds().includes('sparkline'), 'and it leaves DRAWN_KINDS');
});

test('react-x11/style is enough to speak the vocabulary from outside', () => {
  assert.strictEqual(isStyleProp('backgroundColor'), true);
  assert.strictEqual(isStyleProp('title'), false);
  assert.deepStrictEqual(flattenStyle([{ width: 1 }, { height: 2 }]), {
    width: 1,
    height: 2,
  });
});
