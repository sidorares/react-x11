// `<window transparent>` / `<popup transparent>`: the ARGB visual it asks the
// connection for, and the paint path that follows from having an alpha
// channel — erase where an opaque window fills, and round the background so
// the compositor shows the desktop through the corners.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(windowProps = {}, children = null) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', { width: 200, height: 100, ...windowProps }, children),
  );
  await tick();
  return { app, x11Root, wnd: app.windows[0] };
}

test('<window transparent> is created on the 32-bit visual', async () => {
  const { app, x11Root, wnd } = await mount({ transparent: true });

  assert.strictEqual(wnd.attributes.depth, 32);
  assert.strictEqual(wnd.attributes.visual, app.findArgbVisual().visual);
  // transparent black, so nothing flashes white before the first paint
  assert.strictEqual(wnd.attributes.backgroundPixel, 0);
  // a react-x11 concept, not one of ntk's creation attributes
  assert.ok(!('transparent' in wnd.attributes));

  await x11Root.unmount();
});

test('an opaque window is untouched: no visual, no depth', async () => {
  const { x11Root, wnd } = await mount();

  assert.ok(!('depth' in wnd.attributes));
  assert.ok(!('visual' in wnd.attributes));
  assert.ok(!('backgroundPixel' in wnd.attributes));

  await x11Root.unmount();
});

test('a display with no 32-bit visual falls back to an opaque window', async () => {
  const app = createMockApp();
  // XQuartz, and every server without a depth-32 TrueColor visual
  delete app.findArgbVisual;
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 100, transparent: true }));
  await tick();
  const wnd = app.windows[0];

  assert.ok(!('depth' in wnd.attributes), 'no visual to ask for');
  assert.strictEqual(wnd._reactX11Node._transparent, false);
  // and it paints like the opaque window it now is
  assert.ok(
    wnd.ctx.ops.some(([op]) => op === 'fillRect'),
    'still fills its background',
  );
  assert.ok(!wnd.ctx.ops.some(([op]) => op === 'clearRect'));

  await x11Root.unmount();
});

test('a transparent window clears where an opaque one fills white', async () => {
  const { x11Root, wnd } = await mount({ transparent: true });

  const cleared = wnd.ctx.ops.find(([op]) => op === 'clearRect');
  assert.deepStrictEqual(
    cleared,
    ['clearRect', 0, 0, 200, 100],
    'the mount frame erases the whole window',
  );
  // no background asked for, so nothing is painted back over the clear
  assert.ok(
    !wnd.ctx.ops.some(
      ([op, , , , , color]) => op === 'fillRect' && color === 'white',
    ),
    'never falls back to white — that is the opaque window default',
  );

  await x11Root.unmount();
});

test('borderRadius rounds a transparent window, and the clear comes first', async () => {
  const { x11Root, wnd } = await mount({
    transparent: true,
    style: { backgroundColor: 'rgba(24, 24, 30, 0.86)', borderRadius: 14 },
  });

  const ops = wnd.ctx.ops;
  const clearAt = ops.findIndex(([op]) => op === 'clearRect');
  const roundAt = ops.findIndex(([op]) => op === 'roundRect');
  assert.ok(clearAt !== -1, 'erased first');
  assert.deepStrictEqual(
    ops[roundAt],
    ['roundRect', 0, 0, 200, 100, 14],
    'the background is the window, rounded',
  );
  assert.ok(
    clearAt < roundAt,
    'clearing after painting would erase the background it just laid down',
  );
  assert.deepStrictEqual(ops[roundAt + 1], ['fill', 'rgba(24, 24, 30, 0.86)']);

  await x11Root.unmount();
});

test('an opaque window ignores borderRadius, and still fills its rect', async () => {
  const { x11Root, wnd } = await mount({
    style: { backgroundColor: '#101014', borderRadius: 14 },
  });

  // rounding an opaque window would only expose the server's white; the
  // corners are the compositor's to show through, and there is no alpha here
  assert.ok(!wnd.ctx.ops.some(([op]) => op === 'roundRect'));
  assert.ok(
    wnd.ctx.ops.some(
      ([op, x, y, w, hh, color]) =>
        op === 'fillRect' &&
        x === 0 &&
        y === 0 &&
        w === 200 &&
        hh === 100 &&
        color === '#101014',
    ),
  );

  await x11Root.unmount();
});

test('<popup transparent> keeps override-redirect and gets the visual', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('popup', {
        transparent: true,
        x: 10,
        y: 10,
        width: 120,
        height: 80,
        style: { backgroundColor: 'rgba(0, 0, 0, 0.8)', borderRadius: 12 },
      }),
    ),
  );
  await tick();
  const [, popup] = app.windows;

  assert.strictEqual(popup.attributes.depth, 32);
  assert.strictEqual(popup.attributes.overrideRedirect, true);
  assert.strictEqual(popup.attributes.backgroundPixel, 0);
  assert.deepStrictEqual(
    popup.ctx.ops.find(([op]) => op === 'roundRect'),
    ['roundRect', 0, 0, 120, 80, 12],
  );

  await x11Root.unmount();
});

test('a partial repaint clears only its damage rect, and re-rounds the corner', async () => {
  const ref = React.createRef();
  const { x11Root, wnd } = await mount(
    {
      transparent: true,
      style: { backgroundColor: 'rgba(24, 24, 30, 0.86)', borderRadius: 14 },
    },
    h('box', {
      ref,
      style: {
        width: 40,
        height: 20,
        backgroundColor: '#111111',
        ':hover': { backgroundColor: '#333333' },
      },
    }),
  );
  wnd.ctx.ops.length = 0;

  ref.current.setStyleState(':hover', true);
  await tick();

  const cleared = wnd.ctx.ops.filter(([op]) => op === 'clearRect');
  assert.strictEqual(cleared.length, 1, 'one clear for the one damage rect');
  const [, , , w, hh] = cleared[0];
  assert.ok(
    w < 200 || hh < 100,
    `bounded to the damage, got ${w}x${hh} of a 200x100 window`,
  );
  // the rounded background is redrawn under the clip, so a repaint that
  // touches a corner still gets that corner's curve rather than a square patch
  assert.ok(wnd.ctx.ops.some(([op]) => op === 'roundRect'));

  await x11Root.unmount();
});
