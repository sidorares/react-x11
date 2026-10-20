// CSS's `currentColor` (src/currentcolor.js): a colour that is the node's
// ink, written wherever a colour is.
//
// Four things are pinned here. The grammar takes it everywhere it takes a
// colour, spelled any way CSS spells it, and refuses it only where it cannot
// mean anything — the end of a loop. It resolves to the node's resolved ink,
// its own `color` over what it inherits, on every reader of a style colour:
// the shared paint, the transitions and the Cocoa layer presenter. It paints
// the pixels the colour it stands for paints. And a retained presenter, which
// re-rasters by node, hears about an ink an ancestor moved. The damage half —
// a `:hover { color }` on a row repainting the borders under it, bounded —
// is in test/dirty-rect.test.js beside the rules it follows.
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { isCurrentColor } from '../src/currentcolor.js';
import { setAnimationClock } from '../src/nodes/animation.js';
import {
  flattenStyle,
  paintsCurrentColor,
  resolveComputedStyle,
  validateStyle,
} from '../src/styles.js';
import { renderX11, cleanup } from '../src/testing/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { presenterFor } from './helpers/layer-presenter.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(async () => {
  await cleanup();
});

const problem = (style) => {
  try {
    validateStyle(flattenStyle(style), '<box style>');
    return null;
  } catch (err) {
    return err.message;
  }
};

test('currentColor is a colour wherever the grammar takes one, in any case', () => {
  assert.ok(isCurrentColor('currentColor'));
  assert.ok(isCurrentColor('currentcolor'));
  assert.ok(isCurrentColor(' CURRENTCOLOR '));
  assert.ok(!isCurrentColor('current-color'));
  assert.ok(!isCurrentColor('red'));
  assert.ok(!isCurrentColor(undefined));
  for (const style of [
    { backgroundColor: 'currentColor' },
    { borderColor: 'currentcolor' },
    { borderColor: '#ccc currentColor' },
    { borderStartColor: 'currentColor', borderTopColor: 'CurrentColor' },
    { outlineColor: 'currentColor' },
    // on `color` itself it is the ink inherited, as CSS has it
    { color: 'currentColor' },
    { background: 'currentColor' },
    { border: '1px solid currentColor' },
    { outline: '2px currentColor' },
    { backgroundImage: 'linear-gradient(currentColor, transparent)' },
    { background: 'linear-gradient(currentColor 20%, #fff) currentColor' },
    { boxShadow: '0 1px 2px currentColor, 0 0 4px #0003' },
    { ':hover': { borderColor: 'currentColor', background: 'currentColor' } },
  ]) {
    assert.equal(problem(style), null, JSON.stringify(style));
  }
  // and the message for what is not a colour says it is one
  assert.match(
    problem({ borderColor: 'current' }),
    /'transparent' or 'currentColor' — or a \$token/,
  );
  // a shadow has one way to say it: the keyword written out is a shadow
  // with no colour of its own, which the paint already resolves to the ink
  assert.ok(paintsCurrentColor({ boxShadow: '0 1px 2px currentColor' }));
  assert.ok(paintsCurrentColor({ boxShadow: '0 1px 2px' }));
  assert.ok(!paintsCurrentColor({ boxShadow: '0 1px 2px red' }));
  assert.ok(paintsCurrentColor({ borderLeftColor: 'currentColor' }));
  assert.ok(
    paintsCurrentColor({
      backgroundImage: 'linear-gradient(red, currentColor)',
    }),
  );
  assert.ok(paintsCurrentColor(resolveComputedStyle({ border: '1px solid' })));
  // `color` is the ink, not a thing painted in it
  assert.ok(!paintsCurrentColor({ color: 'currentColor' }));
});

test('a loop cannot run to currentColor, and says what to loop instead', () => {
  assert.match(
    problem({
      borderColor: 'red',
      animation: { borderColor: { to: 'currentColor', duration: 400 } },
    }),
    /runs to or from currentColor.*loop `color` instead/,
  );
  // …from the style's own value too
  assert.match(
    problem({
      backgroundColor: 'currentColor',
      animation: { backgroundColor: { to: 'red', duration: 400 } },
    }),
    /runs to or from currentColor/,
  );
});

test('it resolves to the node’s ink: its own color over what it inherits', async () => {
  const { windowNode } = await renderX11(
    h(
      'box',
      { style: { color: '#123456' } },
      h('box', { style: { borderColor: 'currentColor' } }),
      h('box', {
        style: { color: '#abcdef', backgroundColor: 'currentColor' },
      }),
      // `color: currentColor` is CSS's inherit
      h('box', { style: { color: 'currentColor' } }),
    ),
    { backend: 'mock' },
  );
  const [inherits, own, inheritsByKeyword] = windowNode.children[0].children;
  assert.equal(inherits.resolveColor('currentColor'), '#123456');
  assert.equal(own.resolveColor('currentColor'), '#abcdef');
  assert.equal(inheritsByKeyword.resolveColor('currentColor'), '#123456');
  // anything else is handed back as it is
  assert.equal(own.resolveColor('red'), 'red');
  assert.equal(own.resolveColor(undefined), undefined);
  // the style keeps the keyword — CSS's computed value — which is what lets
  // the ink move under it without a restyle
  assert.equal(inherits.style.borderColor, 'currentColor');
});

test('a transition to or from currentColor runs between the colours at the swap, then follows the ink', async () => {
  let now = 1000;
  setAnimationClock(() => now);
  const app = createMockApp();
  const root = await createRoot({ app });
  try {
    const card = (style) =>
      h(
        'window',
        { width: 200, height: 100 },
        h(
          'box',
          { style: { color: '#0000ff' } },
          h('box', {
            style: {
              width: 40,
              height: 40,
              borderWidth: 2,
              transition: { borderColor: 400 },
              ...style,
            },
          }),
        ),
      );
    root.render(card({ borderColor: '#ff0000' }));
    await tick(); // placed: a change from here on transitions
    const node = app.windows[0]._reactX11Node.children[0].children[0];

    root.render(card({ borderColor: 'currentColor' }));
    const entry = node._anim?.get('borderColor');
    assert.ok(entry, 'the change to currentColor transitions');
    assert.equal(entry.from, '#ff0000');
    assert.equal(entry.to, '#0000ff', 'the keyword as the ink at the swap');
    assert.equal(node._targetStyle.borderColor, 'currentColor');

    now += 200;
    node._tickAnimations(now);
    assert.match(node.style.borderColor, /^rgba\(/, 'a colour on the way');
    now += 400;
    node._tickAnimations(now);
    assert.equal(
      node.style.borderColor,
      'currentColor',
      'landed on the style, where the keyword follows the ink again',
    );

    // and back out of it, from the ink as it is now
    root.render(card({ borderColor: '#00ff00' }));
    assert.equal(node._anim.get('borderColor').from, '#0000ff');
    now += 1000;
    node._tickAnimations(now);

    // an ink that moves under the keyword is not a change of the property:
    // nothing transitions, and the border is the new ink at once
    root.render(card({ borderColor: 'currentColor' }));
    now += 1000;
    node._tickAnimations(now);
    const before = node._anim?.size ?? 0;
    root.render(
      h(
        'window',
        { width: 200, height: 100 },
        h(
          'box',
          { style: { color: '#ff00ff' } },
          h('box', {
            style: {
              width: 40,
              height: 40,
              borderWidth: 2,
              transition: { borderColor: 400 },
              borderColor: 'currentColor',
            },
          }),
        ),
      ),
    );
    assert.equal(node._anim?.size ?? 0, before, 'no transition started');
    assert.equal(node.resolveColor(node.style.borderColor), '#ff00ff');
  } finally {
    root.unmount();
    setAnimationClock(() => Date.now());
  }
});

test('currentColor paints the pixels the ink it stands for paints', async (t) => {
  const W = 220;
  const H = 90;
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await x11Root.unmount();
    await app.close();
  });
  const settle = () =>
    new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  const box = { margin: 12, width: 80, height: 50 };
  const paint = (first, second) =>
    new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: W, height: H, style: { backgroundColor: '#ffffff' } },
          h(
            'box',
            { style: { flexDirection: 'row', color: '#d03030' } },
            h('box', { style: { ...box, ...first } }),
            h('box', { style: { ...box, ...second } }),
          ),
        ),
        resolve,
      ),
    ).then(async (wnd) => {
      const root = wnd._reactX11Node;
      root.invalidate(false);
      root._scheduled = false;
      root.flush();
      await settle();
      return new Promise((resolve, reject) =>
        root._ctx.getImageData(0, 0, W, H, (err, data) =>
          err ? reject(err) : resolve(Buffer.from(data.data)),
        ),
      );
    });
  const named = await paint(
    {
      borderWidth: 3,
      borderStyle: 'dashed',
      borderColor: '#d03030',
      borderBottomWidth: 6,
      borderBottomColor: '#3050d0',
      backgroundImage: 'linear-gradient(#d03030, #ffffff)',
      outlineWidth: 2,
      outlineColor: '#d03030',
      boxShadow: '4px 4px #d03030',
    },
    {
      color: '#20a040',
      backgroundColor: '#20a040',
      borderWidth: 2,
      borderColor: '#20a040',
    },
  );
  const current = await paint(
    {
      // inherited from the row: no colour on the line but the side's own
      border: '3px dashed',
      borderBottom: '6px #3050d0',
      backgroundImage: 'linear-gradient(currentColor, #ffffff)',
      outline: '2px',
      boxShadow: '4px 4px currentColor',
    },
    {
      // its own `color` wins over the row's
      color: '#20a040',
      background: 'currentColor',
      border: '2px solid currentcolor',
    },
  );
  // the premise: both inks were drawn
  const has = (px, r, g, b) => {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === r && px[i + 1] === g && px[i + 2] === b) return true;
    }
    return false;
  };
  assert.ok(has(named, 0xd0, 0x30, 0x30), 'the inherited ink was painted');
  assert.ok(has(named, 0x20, 0xa0, 0x40), 'the own ink was painted');
  assert.ok(current.equals(named), 'currentColor painted what the ink paints');
});

test('the layer presenter resolves currentColor, and re-rasters a box whose ink an ancestor moved', async () => {
  const mounted = await renderX11(
    h(
      'box',
      {
        style: {
          width: 200,
          height: 100,
          color: '#ff0000',
          ':hover': { color: '#0000ff' },
        },
      },
      // a plain box: its colours are its layer's properties
      h('box', {
        style: { width: 40, height: 40, border: '2px solid' },
      }),
      // a dashed one is a raster, which the presenter repaints by node
      h('box', {
        style: { width: 40, height: 40, border: '2px dashed' },
      }),
    ),
    { backend: 'mock' },
  );
  const { windowNode } = mounted;
  const row = windowNode.children[0];
  const [plain, dashed] = row.children;
  const { presenter, bridge } = presenterFor(mounted);
  presenter.frame(windowNode);
  assert.ok(!presenter.visuals.get(plain).isRaster, 'the premise: a layer');
  assert.ok(presenter.visuals.get(dashed).isRaster, 'the premise: a raster');
  const borderOf = () =>
    bridge
      .argsOf('setLayerProps')
      .flatMap(([p]) => (p.borderColor ? [p.borderColor] : []))
      .at(-1);
  assert.deepEqual(borderOf(), [1, 0, 0, 1], 'the ink, not nothing');

  bridge.calls.length = 0;
  row.setStyleState(':hover', true);
  presenter.frame(windowNode);
  assert.deepEqual(borderOf(), [0, 0, 1, 1], 'the layer follows the ink');
  assert.equal(
    bridge.uploads(),
    1,
    'the raster under the row was painted again, and only it',
  );
});
