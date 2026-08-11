// A size the element itself decides: `measureContent` + `invalidateMeasure`
// (#250).
//
// The element under test is written the way a third-party one would be —
// everything it uses comes from the published subpaths, and nothing in it
// names `this.yoga`, a yoga constant or an underscore. That is the whole
// point of the issue: before this, an element with an intrinsic size had to
// reach past the public surface for `setMeasureFunc`, and one that did was
// invisible to the content floor `minWidth: 'auto'` is measured with (#248).
//
// Headless, so there are no fonts (see AGENTS.md): the gauge below measures
// out of arithmetic rather than out of text.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { registerElement, unregisterElement } from '../src/host.js';
import { Node, intrinsicSize } from '../src/node.js';
import { renderX11, cleanup } from '../src/testing/index.js';

const h = React.createElement;

/** One tick of the gauge, and the smallest width it can be drawn at. */
const TICK = 30;

/**
 * A dial: `ticks` marks at `TICK` pixels each, 24 tall, and never narrower
 * than a single tick however little room is on offer — the three answers the
 * mode table in docs/extending.md asks for.
 */
class GaugeNode extends Node {
  constructor(props, app) {
    super('gauge', props, app);
    this.measured = 0;
  }

  measureContent({ width }) {
    this.measured++;
    const ticks = Math.max(1, Number(this.props.ticks ?? 4));
    return {
      width: Math.max(TICK, Math.min(ticks * TICK, width)),
      height: 24,
    };
  }

  applyProps(next, prev) {
    const before = prev ?? this.props;
    super.applyProps(next, prev);
    if (next.ticks !== before.ticks) this.invalidateMeasure();
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

/** Mount a `<window>` of our own, into the mock connection. */
const mount = (props, ...children) =>
  renderX11(h('window', { title: 'measure', ...props }, ...children), {
    backend: 'mock',
  });

/** A gauge that is measured rather than stretched: `stretch` is the default
 * cross-axis alignment, and it overrides what a leaf measured to. */
const gauge = (props) =>
  h('gauge', {
    ticks: 4,
    ...props,
    style: { alignSelf: 'flex-start', ...props?.style },
  });

const found = (node, kind) =>
  node.kind === kind
    ? node
    : (node.children.map((c) => found(c, kind)).find(Boolean) ?? null);

/** The hints the window was created with, or the last ones written to it. */
const hintsOf = (wnd) => {
  const sent = wnd.calls.filter(([name]) => name === 'setSizeHints');
  return sent.length ? sent[sent.length - 1][1] : wnd.attributes.sizeHints;
};

/**
 * Assert a mount throws, without React's report of the escaping error on
 * stderr — the message under test is the one thrown, not the one React logs
 * about it. Same shape as the console capture in register-element.test.js.
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

// --- the three questions layout asks ----------------------------------------

test('unconstrained: the element answers with its natural size', async () => {
  register('gauge', {
    create: (props, app) => new GaugeNode(props, app),
    semanticNames: ['ticks'],
  });
  // An `'auto'` window is sized by laying its content out with no available
  // width at all, which is where the unconstrained mode is reached from
  // JSX — and it is the case a `Math.min` against yoga's own "no bound"
  // would answer 0 to.
  const { windowNode, window: wnd } = await mount(
    { width: 'auto', height: 'auto' },
    gauge(),
  );
  assert.deepStrictEqual(
    [
      found(windowNode, 'gauge').abs.width,
      found(windowNode, 'gauge').abs.height,
    ],
    [4 * TICK, 24],
    'four ticks wide, its own height',
  );
  assert.strictEqual(
    wnd.attributes.width,
    4 * TICK,
    'and the window was created around it',
  );
});

test('at-most: the natural size is clamped into the offer', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  const { windowNode } = await mount(
    { width: 200, height: 120 },
    gauge({ ticks: 12 }),
  );
  assert.strictEqual(
    found(windowNode, 'gauge').abs.width,
    200,
    '12 ticks want 360; the window has 200',
  );
});

test('exactly: the style decided that axis, the element answers the other', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  const { windowNode } = await mount(
    { width: 200, height: 120 },
    gauge({ style: { width: 90 } }),
  );
  const dial = found(windowNode, 'gauge');
  assert.deepStrictEqual(
    [dial.abs.width, dial.abs.height],
    [90, 24],
    "the width is the style's, the height is still the element's",
  );
});

test('an answer larger than the offer overflows rather than being clamped', async () => {
  // `at-most` is what is available, not a cap the renderer enforces — which
  // is what content that does not reflow needs: `<text textWrap="nowrap">`
  // runs off the edge, and so does a code block that scrolls sideways.
  class RigidNode extends Node {
    constructor(props, app) {
      super('rigid', props, app);
    }

    measureContent() {
      return { width: 500, height: 20 };
    }
  }
  register('rigid', { create: (p, a) => new RigidNode(p, a) });
  const { windowNode } = await mount(
    { width: 200, height: 120 },
    h('rigid', { style: { alignSelf: 'flex-start' } }),
  );
  assert.strictEqual(found(windowNode, 'rigid').abs.width, 500);
});

// --- saying the answer moved ------------------------------------------------

test('invalidateMeasure() is what makes the next frame ask again', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  const { windowNode, rerender } = await mount(
    { width: 400, height: 120 },
    gauge(),
  );
  const dial = found(windowNode, 'gauge');
  assert.strictEqual(dial.abs.width, 4 * TICK);

  await rerender(
    h(
      'window',
      { title: 'measure', width: 400, height: 120 },
      gauge({ ticks: 7 }),
    ),
  );
  assert.strictEqual(
    dial.abs.width,
    7 * TICK,
    'the measurement reads `ticks`, so a new one has to be taken',
  );
});

test('a measurement nobody invalidated is reused, cache and all', async () => {
  // The other half of the contract, and the reason `invalidateMeasure` is
  // not something the renderer can do on the element's behalf: it cannot
  // know which props the measurement read.
  class Frozen extends GaugeNode {
    applyProps(next, prev) {
      Node.prototype.applyProps.call(this, next, prev);
    }
  }
  register('gauge', { create: (p, a) => new Frozen(p, a) });
  const { windowNode, rerender } = await mount(
    { width: 400, height: 120 },
    gauge(),
  );
  const dial = found(windowNode, 'gauge');
  await rerender(
    h(
      'window',
      { title: 'measure', width: 400, height: 120 },
      gauge({ ticks: 7 }),
    ),
  );
  assert.strictEqual(dial.props.ticks, 7, 'the prop did arrive');
  assert.strictEqual(dial.abs.width, 4 * TICK, 'the size did not');
});

// --- the content floor (#248) ----------------------------------------------

// **Stretched on purpose**, which is the case the seam exists for: the floor
// is measured by laying the tree out with no room at all, and a leaf with the
// default `align-items: stretch` comes out of that pass at its container's
// size — nothing. So the size it *would* have drawn at is recorded nowhere
// but in its measure function, and the pass has to ask it again directly.
// An element whose measure function went in through raw `yoga.setMeasureFunc`
// is not there to ask, and these come out 0.
const stretchedGauge = (props) => h('gauge', { ticks: 4, ...props });

test('a measured element is what floors a minWidth="auto" window', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  const { window: wnd, windowNode } = await mount(
    { width: 400, height: 120, minWidth: 'auto' },
    stretchedGauge(),
  );
  assert.strictEqual(
    found(windowNode, 'gauge').abs.width,
    400,
    'precondition: stretched, so its own width is nowhere in the layout',
  );
  assert.strictEqual(hintsOf(wnd).minWidth, TICK);
});

test('the floor carries the padding that surrounds the content', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  const { window: wnd } = await mount(
    { width: 400, height: 120, minWidth: 'auto', style: { padding: 12 } },
    stretchedGauge(),
  );
  assert.strictEqual(hintsOf(wnd).minWidth, TICK + 24);
});

test('minHeight="auto" reaches the same element down the other axis', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  const { window: wnd } = await mount(
    { width: 400, height: 120, minHeight: 'auto' },
    stretchedGauge(),
  );
  assert.strictEqual(hintsOf(wnd).minHeight, 24);
});

// --- the intrinsic-size recipe ----------------------------------------------

test('intrinsicSize keeps an aspect ratio the way <image> does', async () => {
  class ThumbNode extends Node {
    constructor(props, app) {
      super('thumb', props, app);
    }

    measureContent(constraints) {
      return intrinsicSize({ width: 400, height: 100 }, constraints);
    }
  }
  register('thumb', { create: (p, a) => new ThumbNode(p, a) });

  const { windowNode } = await mount(
    { width: 200, height: 200 },
    h('thumb', { key: 'shrunk', style: { alignSelf: 'flex-start' } }),
    h('thumb', {
      key: 'tall',
      style: { height: 20, alignSelf: 'flex-start' },
    }),
  );
  const [shrunk, tall] = windowNode.children.filter((c) => c.kind === 'thumb');
  assert.deepStrictEqual(
    [shrunk.abs.width, shrunk.abs.height],
    [200, 50],
    '4:1 shrunk into a 200-wide window',
  );
  assert.deepStrictEqual(
    [tall.abs.width, tall.abs.height],
    [80, 20],
    'a style height scales the width with it',
  );
});

// --- the two mistakes the seam can be made ----------------------------------

test('an element that measures itself cannot also arrange children', async () => {
  register('gauge', { create: (p, a) => new GaugeNode(p, a) });
  // Left to yoga this is an abort of the WebAssembly module — the process
  // dies naming nothing the developer wrote — so the check is worth its
  // property read.
  await rejectsQuietly(
    () =>
      mount(
        { width: 200, height: 120 },
        h('gauge', { ticks: 2 }, h('box', { style: { width: 5 } })),
      ),
    /<gauge> measures its own content, so it cannot contain <box>/,
  );
});

test('a measurement that is not a size says so, naming the element', async () => {
  class BrokenNode extends Node {
    constructor(props, app) {
      super('broken', props, app);
    }

    measureContent() {
      return { width: 10 };
    }
  }
  register('broken', { create: (p, a) => new BrokenNode(p, a) });
  await rejectsQuietly(
    () => mount({ width: 'auto', height: 'auto' }, h('broken', {})),
    /<broken>\.measureContent\(\) must return \{ width, height \} as finite numbers; it returned \{ width: 10, height: undefined \}/,
  );
});

test('invalidateMeasure() on an element that measures nothing says so', async () => {
  // The trap it exists for: `measureContent` assigned in the constructor
  // rather than written as a method. The base constructor is what wires it,
  // so the element measures nothing and every invalidation is a no-op —
  // which looks like a broken element rather than a mis-declared one.
  class LateNode extends Node {
    constructor(props, app) {
      super('late', props, app);
      this.measureContent = () => ({ width: 40, height: 40 });
    }
  }
  register('late', { create: (p, a) => new LateNode(p, a) });
  const said = [];
  const origWarn = console.warn;
  console.warn = (...args) => said.push(args.join(' '));
  try {
    const { windowNode } = await mount(
      { width: 200, height: 120 },
      h('late', { style: { alignSelf: 'flex-start' } }),
    );
    const node = found(windowNode, 'late');
    assert.strictEqual(node.abs.width, 0, 'never asked, so it has no size');
    node.invalidateMeasure();
    node.invalidateMeasure();
  } finally {
    console.warn = origWarn;
  }
  assert.strictEqual(said.length, 1, 'once, not once per call');
  assert.match(said[0], /<late>\.invalidateMeasure\(\) has nothing to/);
  assert.match(said[0], /method on the class/);
});

test('the built-ins that measure are held to it too', async () => {
  // Not a new restriction — yoga has always aborted on this — but the error
  // now names both elements instead of killing the process. `<text>`,
  // `<markdown>` and `<tex>` are turned away earlier still, by the
  // reconciler, which knows what their content is supposed to be.
  await rejectsQuietly(
    () =>
      mount(
        { width: 200, height: 120 },
        h('textarea', {}, h('box', { style: { width: 5 } })),
      ),
    /<textarea> measures its own content, so it cannot contain <box>/,
  );
});
