// `opacity` (issue #587): how opaque a node is with everything inside it.
//
// The difference from a colour's own alpha is the whole feature. An alpha on
// each fill fades one flat box; it cannot fade a card with a border, an icon
// and a caption, because each of those would be drawn translucent over the
// others — the card showing through the icon. `opacity` draws the subtree
// once, into a surface, and composites that at the alpha (`NodePaint._paintGroup`),
// which is CSS's rule. So the pixel tests here are about the overlap: a red
// child inside a half-faded blue card is half-faded **red**, not red over
// half-faded blue.
//
// The in-process X server for pixels; the mock app with the frame clock in
// hand for the transition and the loop; the fake AppKit bridge for the Cocoa
// surface presenter, which paints through the same walk.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { setAnimationClock } from '../src/nodes/animation.js';
import { BoxNode } from '../src/nodes/box.js';
import { registerElement, unregisterElement } from '../src/registry.js';
import {
  act,
  cleanup,
  fireEvent,
  pixelAt,
  renderX11,
} from '../src/testing/index.js';
import { mountCocoa, cleanupCocoa } from './helpers/cocoa-bridge.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await cleanup();
  await cleanupCocoa();
});

/** Channel by channel, within a rounding step or two. */
function assertNear(actual, expected, what) {
  const off = actual.some((c, i) => Math.abs(c - expected[i]) > 3);
  assert.ok(!off, `${what}: got ${actual}, expected about ${expected}`);
}

const row = (...children) =>
  h(
    'box',
    {
      style: { flexDirection: 'row', flexGrow: 1, backgroundColor: '#ffffff' },
    },
    ...children,
  );

test('a node fades with everything in it, as one', async () => {
  const api = await renderX11(
    row(
      h('box', {
        style: {
          width: 40,
          height: 40,
          backgroundColor: '#ff0000',
          opacity: 0.5,
        },
      }),
      h(
        'box',
        {
          style: {
            width: 40,
            height: 40,
            backgroundColor: '#0000ff',
            opacity: 0.5,
          },
        },
        h('box', {
          style: { width: 20, height: 20, backgroundColor: '#ff0000' },
        }),
      ),
    ),
    { width: 100, height: 40 },
  );
  await act();
  assertNear(await pixelAt(api.ctx, 10, 10), [255, 128, 128], 'a lone box');
  // the child inside the faded card: red at half over the white window —
  // per-draw alpha would have put half-red over half-blue, (192, 64, 128)
  assertNear(
    await pixelAt(api.ctx, 45, 5),
    [255, 128, 128],
    'the child is faded as part of the card, not over it',
  );
  assertNear(await pixelAt(api.ctx, 70, 30), [128, 128, 255], 'the card');
});

test('opacity 0 draws nothing, and the node is still hit', async () => {
  let clicks = 0;
  const api = await renderX11(
    row(
      h('box', {
        testID: 'ghost',
        onClick: () => clicks++,
        style: {
          width: 40,
          height: 40,
          backgroundColor: '#00ff00',
          opacity: 0,
        },
      }),
    ),
    { width: 60, height: 40 },
  );
  await act();
  assertNear(await pixelAt(api.ctx, 20, 20), [255, 255, 255], 'nothing drawn');
  const ghost = api.windowNode.children[0].children[0];
  // identity, not `equal`: a failing diff of a surface walks the whole X
  // connection it holds, and takes minutes to say what it found
  assert.ok(ghost._groupSurface === null, 'and no surface drawn at nothing');
  fireEvent.click(ghost);
  await act();
  assert.equal(clicks, 1, 'CSS hits an invisible node, and so does this');
});

test('a gradient and a border inside a group land where they would unfaded', async () => {
  // The group is drawn at an offset into its surface. A gradient made under
  // that offset has to come out in the same place as one made without it.
  const card = (opacity) =>
    h('box', {
      style: {
        width: 40,
        height: 20,
        backgroundImage: 'linear-gradient(to right, #000000, #ffffff)',
        borderWidth: 2,
        borderColor: '#ff0000',
        opacity,
      },
    });
  const api = await renderX11(
    h(
      'box',
      { style: { flexGrow: 1, backgroundColor: '#ffffff' } },
      h('box', { style: { height: 20 } }, card(0.999)),
      h('box', { style: { height: 20 } }, card(1)),
    ),
    { width: 40, height: 40 },
  );
  await act();
  for (const x of [1, 10, 20, 30, 38]) {
    assertNear(
      await pixelAt(api.ctx, x, 10),
      await pixelAt(api.ctx, x, 30),
      `column ${x}`,
    );
  }
});

test('the surface is kept while the node is faded, and let go when it is not', async () => {
  let setOpacity;
  function Fading() {
    const [opacity, set] = React.useState(0.5);
    setOpacity = set;
    return row(
      h('box', {
        style: { width: 40, height: 40, backgroundColor: '#ff0000', opacity },
      }),
    );
  }
  const api = await renderX11(h(Fading), { width: 60, height: 40 });
  await act();
  const node = api.windowNode.children[0].children[0];
  const surface = node._groupSurface;
  assert.ok(surface, 'drawn through a surface');

  await act(() => setOpacity(0.25));
  assert.ok(node._groupSurface === surface, 'the next frame reuses it');
  assertNear(await pixelAt(api.ctx, 20, 20), [255, 191, 191], 'at a quarter');

  await act(() => setOpacity(1));
  assert.ok(node._groupSurface === null, 'opaque again: released');
  assertNear(await pixelAt(api.ctx, 20, 20), [255, 0, 0], 'and opaque');

  await act(() => setOpacity(0.5));
  const again = node._groupSurface;
  assert.ok(again);
  await api.unmount();
  assert.ok(node._groupSurface === null, 'released with the node');
});

// --- on the frame clock --------------------------------------------------------

async function withClock(children, body) {
  let clock = 1000;
  setAnimationClock(() => clock);
  let root;
  try {
    const app = createMockApp();
    root = await createRoot({ app });
    const render = (next) =>
      root.render(h('window', { width: 200, height: 100 }, next));
    render(children);
    await tick();
    const window = app.windows[0]._reactX11Node;
    await body({
      window,
      frame(ms) {
        clock += ms;
        window._advanceAnimations(clock);
      },
      render: async (next) => {
        render(next);
        await tick();
      },
    });
  } finally {
    root?.unmount();
    setAnimationClock(() => Date.now());
  }
}

test('opacity transitions, and loops', async () => {
  const faded = (opacity) =>
    h('box', {
      style: {
        width: 40,
        height: 40,
        backgroundColor: '#000',
        opacity,
        transition: { opacity: 200 },
      },
    });
  await withClock(faded(1), async ({ window, frame, render }) => {
    const node = window.children[0];
    await render(faded(0));
    frame(100);
    assert.ok(
      node.style.opacity > 0 && node.style.opacity < 1,
      `halfway through: ${node.style.opacity}`,
    );
    frame(200);
    assert.equal(node.style.opacity, 0, 'and it lands');
  });

  const pulse = h('box', {
    style: {
      width: 40,
      height: 40,
      backgroundColor: '#000',
      animation: { opacity: { from: 1, to: 0.5, duration: 1000 } },
    },
  });
  await withClock(pulse, async ({ window, frame }) => {
    const node = window.children[0];
    frame(500);
    assert.ok(
      Math.abs(node.style.opacity - 0.75) < 0.01,
      `a loop at its middle: ${node.style.opacity}`,
    );
  });
});

test('an opacity that is not a number says what to write', async () => {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => errors.push(error),
  });
  root.render(
    h(
      'window',
      { width: 100, height: 100 },
      h('box', { style: { opacity: '50%' } }),
    ),
  );
  await tick();
  assert.match(errors[0]?.message ?? '', /invalid opacity "50%"/);
  assert.match(errors[0].message, /opacity: 0\.5 is half/);
  errors.length = 0;
  // …and in a state block, where it is paint like the rest; and unset, the
  // way a conditional writes it
  root.render(
    h(
      'window',
      { width: 100, height: 100 },
      h('box', { style: { opacity: 0.6, ':hover': { opacity: 1 } } }),
      h('box', { style: { opacity: undefined } }),
      h('box', { style: { opacity: null } }),
    ),
  );
  await tick();
  assert.deepEqual(errors, []);
  await root.unmount();
});

test('on the Cocoa surface presenter the group composites a surface at the alpha', async () => {
  const mounted = await mountCocoa(
    h('box', {
      style: {
        width: 40,
        height: 40,
        backgroundColor: '#ff0000',
        opacity: 0.4,
      },
    }),
    { width: 60, height: 60, promote: false },
  );
  mounted.frame();
  const alphas = mounted.native.of('ctxSetGlobalAlpha').map(([, a]) => a);
  assert.ok(alphas.includes(0.4), `composited at 0.4: ${alphas}`);
  assert.ok(
    mounted.native.of('ctxDrawSurface').length > 0,
    'from a surface of its own',
  );
});

test('a faded box is not lifted onto a layer of its own, where it would fade in pieces', async () => {
  const pulse = (more) =>
    h('box', {
      style: {
        position: 'absolute',
        left: 10,
        top: 10,
        width: 40,
        height: 20,
        backgroundColor: '#ff0000',
        animation: {
          backgroundColor: { to: '#00ff00', duration: 900, alternate: true },
        },
        ...more,
      },
    });
  const plain = await mountCocoa(pulse({}), { width: 60, height: 60 });
  plain.frame();
  assert.equal(plain.node.children[0]._promoted, true, 'the control case');

  const faded = await mountCocoa(pulse({ opacity: 0.5 }), {
    width: 60,
    height: 60,
  });
  faded.frame();
  assert.equal(faded.node.children[0]._promoted, false);
  assert.ok(
    faded.native.of('ctxSetGlobalAlpha').some(([, a]) => a === 0.5),
    'drawn through its group on the bitmap',
  );
});

test('on the layer presenter the opacity is the layer’s own', async () => {
  // Both kinds of layer the presenter makes: a plain box's properties, and a
  // raster for an element that draws — `<text>`, whose own paint the
  // presenter replays, and which must not fade itself on the way in as well.
  const mounted = await mountCocoa(
    h(
      'box',
      { style: { flexDirection: 'row' } },
      h('box', {
        style: {
          width: 40,
          height: 40,
          backgroundColor: '#ff0000',
          opacity: 0.5,
        },
      }),
      h('text', { style: { color: '#000', opacity: 0.25 } }, 'faded'),
    ),
    { width: 120, height: 60, presenter: 'layers' },
  );
  mounted.frame();
  const opacities = mounted.native
    .of('setLayerProps')
    .map(([, props]) => props.opacity)
    .filter((o) => o !== undefined && o < 1);
  assert.ok(opacities.includes(0.5), `the box's layer: ${opacities}`);
  assert.ok(opacities.includes(0.25), `the text's layer: ${opacities}`);
  const alphas = mounted.native.of('ctxSetGlobalAlpha').map(([, a]) => a);
  assert.ok(
    !alphas.includes(0.25) && !alphas.includes(0.5),
    `nothing faded a second time on its way in: ${alphas}`,
  );
});

test('an element that draws in paint() is not faded twice on the layer presenter', async (t) => {
  // The presenter replays such an element's own paint into its layer, and
  // puts the opacity on the layer; a group drawn inside that replay as well
  // would fade it a second time. Every drawing element in
  // @react-x11/components is this shape: super.paint(ctx), then the scene.
  class Dial extends BoxNode {
    constructor(props, app) {
      super(props, app);
      this.kind = 'dial';
    }
    paint(ctx) {
      super.paint(ctx);
      ctx.fillStyle = '#000';
      ctx.fillRect(this.abs.x, this.abs.y, 4, 4);
    }
  }
  registerElement('dial', { create: (props, app) => new Dial(props, app) });
  t.after(() => unregisterElement('dial'));
  const mounted = await mountCocoa(
    h('dial', {
      style: { width: 40, height: 40, backgroundColor: '#00f', opacity: 0.25 },
    }),
    { width: 60, height: 60, presenter: 'layers' },
  );
  mounted.frame();
  assert.ok(
    mounted.native.of('setLayerProps').some(([, p]) => p.opacity === 0.25),
    'the layer carries it',
  );
  const alphas = mounted.native.of('ctxSetGlobalAlpha').map(([, a]) => a);
  assert.ok(!alphas.includes(0.25), `and the replay does not: ${alphas}`);
});
