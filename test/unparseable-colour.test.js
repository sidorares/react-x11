// A colour in a style that no backend can parse — `'nonsense'`, `7`, `'#12'`.
//
// ntk's context throws on one from inside the frame flush, where no boundary
// can catch it, so a misspelt `backgroundColor` took the process down; the
// shared context the other backends draw through painted it black instead.
// Now development says so at the commit, naming the property, and the paint
// drops the colour on every backend, as CSS drops a declaration it cannot
// parse: no fill, no stroke, the inherited ink for text.
//
// The paint half is reached through theme tokens. A token is checked only
// once it resolves, which is after the development check has run — the
// path every value takes in a production build.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { createMockApp } from '../src/testing/index.js';
import { isColor } from '../src/styles.js';
import { cleanupCocoa, mountCocoa } from './helpers/cocoa-bridge.js';

const h = React.createElement;
const W = 120;
const H = 80;
const tick = () => new Promise((resolve) => setImmediate(resolve));

afterEach(cleanupCocoa);

test('isColor answers what the backends can parse', () => {
  for (const good of ['#2980b9', '#abc', 'tomato', 'rgba(0, 0, 0, 0.5)']) {
    assert.equal(isColor(good), true, good);
  }
  // `transparent` is a colour, just one that paints nothing
  assert.equal(isColor('transparent'), true);
  for (const bad of ['nonsense', '#12', '', 'rgba(0,0,0,NaN)', '$accent']) {
    assert.equal(isColor(bad), false, JSON.stringify(bad));
  }
  for (const bad of [7, true, null, undefined, [0, 0, 0, 1], {}]) {
    assert.equal(isColor(bad), false, String(bad));
  }
});

test('in development a colour that does not parse is an error at the commit, naming the property', async () => {
  const cases = [
    [{ backgroundColor: 'nonsense' }, /invalid backgroundColor "nonsense"/],
    [{ backgroundColor: 7 }, /invalid backgroundColor 7 in <box style>/],
    [{ backgroundColor: '#12' }, /invalid backgroundColor "#12"/],
    [{ borderTopColor: true, borderWidth: 1 }, /invalid borderTopColor true/],
    [{ outlineColor: 'nope' }, /invalid outlineColor "nope"/],
    [{ ':hover': { backgroundColor: 'nope' } }, /in <box style> :hover/],
    [
      { backgroundImage: 'linear-gradient(nonsense, red)' },
      /colour stop that is not a colour \("nonsense";/,
    ],
    [
      { boxShadow: '0 2px 4px nonsense' },
      /"nonsense", which is neither a length nor a colour/,
    ],
  ];
  for (const [style, message] of cases) {
    const app = createMockApp();
    const errors = [];
    const root = await createRoot({
      app,
      onUncaughtError: (error) => errors.push(error),
    });
    root.render(h('window', { width: W, height: H }, h('box', { style })));
    await tick();
    assert.match(errors[0]?.message ?? '(none)', message);
    assert.match(errors[0].message, /expected/, 'and says what to write');
    await root.unmount();
  }
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => errors.push(error),
  });
  root.render(
    h(
      'window',
      { width: W, height: H },
      h('text', { style: { color: 'nonsense' } }, 'ink'),
    ),
  );
  await tick();
  assert.match(
    errors[0]?.message ?? '(none)',
    /invalid color "nonsense" in <text style>/,
  );
  await root.unmount();
});

test('unset, transparent and tokens are not mistakes', async () => {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => errors.push(error),
  });
  root.render(
    h(
      'window',
      { width: W, height: H },
      h('box', { style: { backgroundColor: undefined } }),
      h('box', { style: { backgroundColor: null } }),
      // `''` has always painted nothing, and a conditional writes it
      h('box', { style: { backgroundColor: '' } }),
      h('box', { style: { backgroundColor: 'transparent' } }),
      h('box', { style: { backgroundColor: '$accent' } }),
      h('box', { style: { backgroundImage: 'linear-gradient($accent, red)' } }),
      h('box', { style: { boxShadow: '0 2px 4px $accent' } }),
      h('text', { style: { color: '' } }, 'inherits'),
    ),
  );
  await tick();
  assert.deepEqual(errors, []);
  await root.unmount();
});

// --- the paint, through the in-process X server -----------------------------

async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  return createClient({ stream: clientEnd });
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

async function mount(app, element) {
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  const root = instance._reactX11Node;
  root._scheduled = false;
  root.flush();
  await settle(app);
  return root;
}

async function shot(root) {
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const data = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );
  const bytes = Buffer.from(data.data);
  return (x, y) => {
    const i = (y * W + x) * 4;
    return [bytes[i], bytes[i + 1], bytes[i + 2]];
  };
}

test('a colour that resolves to nothing paints nothing, and the frame goes on', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      h(
        'window',
        {
          width: W,
          height: H,
          theme: { bad: 'nonsense' },
          style: { backgroundColor: '#ffffff', flexDirection: 'row' },
        },
        h('box', {
          style: {
            width: 40,
            height: 40,
            margin: 8,
            backgroundColor: '$bad',
            borderWidth: 4,
            borderColor: '$bad',
            backgroundImage: 'linear-gradient($bad, #ff0000)',
            boxShadow: '0 4px 0 $bad',
          },
        }),
        // painted after the one that used to throw
        h('box', {
          style: {
            width: 40,
            height: 40,
            margin: 8,
            backgroundColor: '#00ff00',
          },
        }),
      ),
    );
    const at = await shot(root);
    for (const [x, y, what] of [
      [28, 28, 'the fill'],
      [9, 28, 'the border'],
      [28, 50, 'the shadow'],
    ]) {
      assert.deepEqual(at(x, y), [255, 255, 255], `no ${what}`);
    }
    // a gradient with a stop that is not a colour is not half a gradient
    assert.deepEqual(at(28, 45), [255, 255, 255], 'no gradient either');
    assert.deepEqual(at(76, 28), [0, 255, 0], 'and the sibling after it');
  } finally {
    await app.close();
  }
});

test('text whose colour resolves to nothing inherits the ink above it', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      h(
        'window',
        {
          width: W,
          height: H,
          theme: { bad: 'nonsense' },
          style: { backgroundColor: '#ffffff', color: '#ff0000' },
        },
        h('text', { style: { color: '$bad', fontSize: 24 } }, 'MMMM'),
      ),
    );
    const text = root.children[0];
    assert.equal(text.resolvedTextStyle().color, '#ff0000');
    const at = await shot(root);
    let red = 0;
    let other = 0;
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < W; x++) {
        const [r, g, b] = at(x, y);
        if (r === 255 && g === 255 && b === 255) continue;
        if (r > g + 60 && r > b + 60) red++;
        else if (r < 200) other++;
      }
    }
    assert.ok(red > 20, `drawn in the inherited red: ${red} pixels`);
    assert.equal(other, 0, 'and in no other ink');
  } finally {
    await app.close();
  }
});

test("a window's colour that resolves to nothing is the palette's", async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      h('window', {
        width: W,
        height: H,
        theme: { bad: 'nonsense', background: '#123456' },
        style: { backgroundColor: '$bad' },
      }),
    );
    assert.equal(root._windowBackground(), '#123456');
    const at = await shot(root);
    assert.deepEqual(at(60, 40), [0x12, 0x34, 0x56]);
  } finally {
    await app.close();
  }
});

test('a palette whose ink is not a colour sets text in black rather than throwing', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      h(
        'window',
        {
          width: W,
          height: H,
          theme: { text: 'nonsense' },
          style: { backgroundColor: '#ffffff' },
        },
        h('text', { style: { fontSize: 24 } }, 'MMMM'),
      ),
    );
    assert.equal(root.children[0].resolvedTextStyle().color, 'black');
    const at = await shot(root);
    let ink = 0;
    for (let y = 0; y < 30; y++) {
      for (let x = 0; x < W; x++) if (at(x, y)[0] < 128) ink++;
    }
    assert.ok(ink > 20, `the text was drawn: ${ink} pixels`);
  } finally {
    await app.close();
  }
});

test('the shared context paints nothing for one either, where it painted black', async () => {
  const mounted = await mountCocoa(
    h('box', {
      style: { width: 40, height: 40, backgroundColor: '$bad' },
    }),
    { width: 60, height: 60, promote: false, theme: { bad: 'nonsense' } },
  );
  mounted.frame();
  const black = mounted.native
    .of('ctxSetFillColor')
    .filter(([, r, g, b, a]) => r === 0 && g === 0 && b === 0 && a === 1);
  assert.deepEqual(black, []);
});
