// `<window transparent>` / `<popup transparent>`: the ARGB visual it asks the
// connection for, and the paint path that follows from having an alpha
// channel — erase where an opaque window fills, and round the background so
// the compositor shows the desktop through the corners.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot, useSupports } from '../src/index.js';
import { setCompositingForTests } from '../src/compositing.js';
import { resolveQueries } from '../src/style.js';
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
  // It does get a `backgroundPixel` — every window does, so the server fills
  // a resize with the colour that is about to be painted there rather than
  // with its own default. What marks the ARGB path is that the pixel is 0,
  // which on a window with an alpha channel means transparent.
  assert.notEqual(wnd.attributes.backgroundPixel, 0);
  assert.equal(wnd.attributes.backgroundPixel, 0xffffff, 'the light palette');

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

// --- degrading: no compositor, or no visual to composite ------------------
//
// The failure this guards against is specific. A server with 32-bit visuals
// but nothing compositing them will happily create the ARGB window — so
// `transparent` *succeeds* — and then show the cleared corners as black,
// which is worse than the square opaque popup it replaced.

test('an ARGB window with no compositor never clears, and fills square', async () => {
  const app = createMockApp();
  setCompositingForTests(app, false);
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', {
      width: 200,
      height: 100,
      transparent: true,
      style: { backgroundColor: 'rgba(24, 24, 30, 0.86)', borderRadius: 14 },
    }),
  );
  await tick();
  const wnd = app.windows[0];

  // the visual is still taken: a compositor may start later, and the window
  // cannot change visual once created
  assert.strictEqual(wnd.attributes.depth, 32);
  assert.strictEqual(wnd._reactX11Node._transparent, true);
  // …but nothing is composited, so transparency is not in effect
  assert.strictEqual(wnd._reactX11Node.transparencyEffective, false);

  assert.ok(
    !wnd.ctx.ops.some(([op]) => op === 'clearRect'),
    'clearing would leave corners the server shows as black',
  );
  assert.ok(
    !wnd.ctx.ops.some(([op]) => op === 'roundRect'),
    'and rounding would be what gives those corners up',
  );
  assert.ok(
    wnd.ctx.ops.some(
      ([op, x, y, w, hh]) =>
        op === 'fillRect' && x === 0 && y === 0 && w === 200 && hh === 100,
    ),
    'filled edge to edge instead',
  );

  await x11Root.unmount();
});

test('no ARGB visual is the same story, without the window ever being ARGB', async () => {
  const app = createMockApp();
  delete app.findArgbVisual;
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', {
      width: 200,
      height: 100,
      transparent: true,
      style: { backgroundColor: '#101014', borderRadius: 14 },
    }),
  );
  await tick();
  const wnd = app.windows[0];

  assert.strictEqual(wnd._reactX11Node.transparencyEffective, false);
  assert.ok(!wnd.ctx.ops.some(([op]) => op === 'clearRect'));
  assert.ok(!wnd.ctx.ops.some(([op]) => op === 'roundRect'));

  await x11Root.unmount();
});

// --- '@supports transparency' --------------------------------------------

const CARD = {
  backgroundColor: '#1c1c22',
  '@supports transparency': {
    backgroundColor: 'rgba(28, 28, 34, 0.94)',
    borderRadius: 18,
  },
};

test("'@supports transparency' applies when it will actually show", async () => {
  const ref = React.createRef();
  const { x11Root } = await mount(
    { transparent: true },
    h('box', { ref, style: CARD }),
  );

  assert.strictEqual(
    ref.current.style.backgroundColor,
    'rgba(28, 28, 34, 0.94)',
  );
  assert.strictEqual(ref.current.style.borderRadius, 18);

  await x11Root.unmount();
});

test("'@supports transparency' is false in a window that is not transparent", async () => {
  const ref = React.createRef();
  // the compositor is running; this window simply has no alpha channel, so
  // the same component gets the design that works there
  const { x11Root } = await mount({}, h('box', { ref, style: CARD }));

  assert.strictEqual(ref.current.style.backgroundColor, '#1c1c22');
  assert.strictEqual(ref.current.style.borderRadius, undefined);

  await x11Root.unmount();
});

test("'@supports transparency' is false when nothing is compositing", async () => {
  const app = createMockApp();
  setCompositingForTests(app, false);
  const ref = React.createRef();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100, transparent: true },
      h('box', { ref, style: CARD }),
    ),
  );
  await tick();

  assert.strictEqual(ref.current.style.backgroundColor, '#1c1c22');

  await x11Root.unmount();
});

test('a compositor starting re-resolves the blocks under a live window', async () => {
  const app = createMockApp();
  setCompositingForTests(app, false);
  const ref = React.createRef();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      {
        width: 200,
        height: 100,
        transparent: true,
        style: CARD,
      },
      h('box', { ref, style: CARD }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(ref.current.style.backgroundColor, '#1c1c22');
  wnd.ctx.ops.length = 0;

  // a compositing manager takes the selection while the app is running
  setCompositingForTests(app, true);
  await tick();

  assert.strictEqual(
    ref.current.style.backgroundColor,
    'rgba(28, 28, 34, 0.94)',
    'the drawn node followed',
  );
  assert.strictEqual(
    wnd._reactX11Node.transparencyEffective,
    true,
    'and so did the window itself — no remount, the visual was already ARGB',
  );
  assert.ok(
    wnd.ctx.ops.some(([op]) => op === 'clearRect'),
    'which means it may now clear its corners',
  );
  assert.ok(wnd.ctx.ops.some(([op]) => op === 'roundRect'));

  await x11Root.unmount();
});

test('a compositor stopping puts the window back to square and opaque', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', { width: 200, height: 100, transparent: true, style: CARD }),
  );
  await tick();
  const wnd = app.windows[0];
  assert.strictEqual(wnd._reactX11Node.transparencyEffective, true);
  wnd.ctx.ops.length = 0;

  setCompositingForTests(app, false);
  await tick();

  assert.strictEqual(wnd._reactX11Node.transparencyEffective, false);
  assert.ok(
    !wnd.ctx.ops.some(([op]) => op === 'clearRect'),
    'the corners stop being given away the moment nothing blends them',
  );

  await x11Root.unmount();
});

test('useSupports("transparency") tracks the display', async () => {
  const app = createMockApp();
  const seen = [];
  function Probe() {
    seen.push(useSupports('transparency'));
    return null;
  }
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 100, height: 100 }, h(Probe)));
  await tick();
  assert.strictEqual(
    seen.at(-1),
    true,
    'mock display composites and has a visual',
  );

  setCompositingForTests(app, false);
  await tick();
  assert.strictEqual(seen.at(-1), false, 're-rendered when it stopped');

  await x11Root.unmount();
});

test('an unknown @supports feature merges nothing rather than half-matching', async () => {
  // The throw for a typo belongs to validateStyle (see size-queries.test.js);
  // the resolver's job is only to never treat an unparsed key as a match.
  const style = {
    backgroundColor: 'red',
    '@supports nonsense': { backgroundColor: 'blue' },
  };
  assert.strictEqual(
    resolveQueries(style, { supports: { nonsense: true, transparency: true } })
      .backgroundColor,
    'red',
  );
});

// --- the switch -----------------------------------------------------------
//
// A desktop that composites has no other way to look at the opaque design:
// stopping the compositor takes every other window on the screen with it.

test('REACT_X11_NO_TRANSPARENCY=1 ignores the prop, on a display that could', async () => {
  process.env.REACT_X11_NO_TRANSPARENCY = '1';
  const ref = React.createRef();
  try {
    const app = createMockApp(); // composites, and has a 32-bit visual
    const x11Root = await createRoot({ app });
    x11Root.render(
      h(
        'window',
        {
          width: 200,
          height: 100,
          transparent: true,
          style: { backgroundColor: '#101014', borderRadius: 14 },
        },
        h('box', { ref, style: CARD }),
      ),
    );
    await tick();
    const wnd = app.windows[0];

    // created on the ordinary visual, exactly as on a display with none
    assert.ok(!('depth' in wnd.attributes), 'no ARGB visual taken');
    assert.strictEqual(wnd._reactX11Node._transparent, false);
    assert.strictEqual(wnd._reactX11Node.transparencyEffective, false);
    assert.ok(!wnd.ctx.ops.some(([op]) => op === 'clearRect'), 'never erases');
    assert.ok(!wnd.ctx.ops.some(([op]) => op === 'roundRect'), 'square');
    // and the style block that would have rounded it does not match
    assert.strictEqual(ref.current.style.backgroundColor, '#1c1c22');
    assert.strictEqual(ref.current.style.borderRadius, undefined);

    await x11Root.unmount();
  } finally {
    delete process.env.REACT_X11_NO_TRANSPARENCY;
  }
});

test('useSupports("transparency") answers the switch too', async () => {
  // the two have to agree: a window that took the visual under a hook that
  // said no would size a popup for chrome it then refused to draw
  const seen = [];
  function Probe() {
    seen.push(useSupports('transparency'));
    return null;
  }
  process.env.REACT_X11_NO_TRANSPARENCY = '1';
  try {
    const app = createMockApp();
    const x11Root = await createRoot({ app });
    x11Root.render(h('window', { width: 100, height: 60 }, h(Probe)));
    await tick();
    assert.strictEqual(seen.at(-1), false);
    await x11Root.unmount();
  } finally {
    delete process.env.REACT_X11_NO_TRANSPARENCY;
  }

  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 100, height: 60 }, h(Probe)));
  await tick();
  assert.strictEqual(seen.at(-1), true, 'and true again with it unset');
  await x11Root.unmount();
});
