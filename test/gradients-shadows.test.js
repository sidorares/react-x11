// `backgroundImage` and `boxShadow` as pixels (issue #345), against
// node-x11's in-process X server — which implements RENDER's gradients and
// its convolution filter for real, so both features are readable back rather
// than merely "not throwing".
//
// The grammar and the geometry are `test/decorations.test.js`; this file is
// the half that only a server can answer: that the gradient lands in the
// node's own box, that a blurred shadow is drawn *outside* it and fades, and
// that the damage a shadow claims covers it — including the frame that takes
// one away, which is the one way this feature can leave stale pixels behind.
import assert from 'node:assert';
import { test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';

const W = 240;
const H = 180;
const e = React.createElement;

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
  // re-render the same root, painting the frame it asks for
  root.rerender = async (next) => {
    await new Promise((resolve) => x11Root.render(next, resolve));
    root._scheduled = false;
    root.flush();
    await settle(app);
  };
  return root;
}

/** The window, as RGBA rows. `getImageData` speaks straight RGBA (ntk >= 5.3). */
async function shot(root) {
  const ctx = (root._ctx ??= root.window.getContext('2d'));
  const data = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, d) => (err ? reject(err) : resolve(d))),
  );
  const bytes = Buffer.from(data.data);
  return {
    bytes,
    at(x, y) {
      const i = (y * W + x) * 4;
      return [bytes[i], bytes[i + 1], bytes[i + 2]];
    },
    /** 0 = white, 255 = black: how much ink landed here. */
    ink(x, y) {
      const [r, g, b] = this.at(x, y);
      return 255 - Math.round((r + g + b) / 3);
    },
  };
}

const near = (actual, expected, tolerance, what) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${what}: expected ~${expected}, got ${actual}`,
  );

/** One absolutely-positioned box, so every assertion has known geometry. */
const BOX = { x: 60, y: 40, width: 100, height: 80 };
function boxed(style, extra) {
  return e(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' }, ...extra },
    e('box', {
      style: {
        position: 'absolute',
        left: BOX.x,
        top: BOX.y,
        width: BOX.width,
        height: BOX.height,
        ...style,
      },
    }),
  );
}

// --- gradients -------------------------------------------------------------

test('a linear-gradient fills the node’s own box, end to end', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed({ backgroundImage: 'linear-gradient(#ff0000, #0000ff)' }),
    );
    const img = await shot(root);
    const mid = BOX.x + BOX.width / 2;
    // the ends are the authored colours, not a blend that ran out early —
    // which is what a gradient laid out in the wrong coordinates looks like
    near(img.at(mid, BOX.y + 1)[0], 255, 12, 'red at the top');
    near(img.at(mid, BOX.y + 1)[2], 0, 12, 'no blue at the top');
    near(img.at(mid, BOX.y + BOX.height - 2)[2], 255, 12, 'blue at the bottom');
    near(img.at(mid, BOX.y + BOX.height - 2)[0], 0, 12, 'no red at the bottom');
    // and the middle is the middle
    const [r, , b] = img.at(mid, BOX.y + BOX.height / 2);
    near(r, 128, 24, 'half red in the middle');
    near(b, 128, 24, 'half blue in the middle');
    // nothing outside the box was painted
    assert.deepEqual(img.at(BOX.x - 3, BOX.y + 4), [255, 255, 255]);
  } finally {
    await app.close();
  }
});

test('an angle turns it: 90deg runs left to right', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed({ backgroundImage: 'linear-gradient(90deg, #ff0000, #0000ff)' }),
    );
    const img = await shot(root);
    const mid = BOX.y + BOX.height / 2;
    near(img.at(BOX.x + 1, mid)[0], 255, 12, 'red on the left');
    near(img.at(BOX.x + BOX.width - 2, mid)[2], 255, 12, 'blue on the right');
  } finally {
    await app.close();
  }
});

test('a gradient follows the box when the box moves', async () => {
  // The coordinates are absolute, so this is what pins the cache key that
  // carries them: the same hoisted style, a different rect, and the ends
  // still have to land on the ends rather than where they were last frame.
  const app = await headlessApp();
  try {
    const style = {
      backgroundImage: 'linear-gradient(90deg, #ff0000, #0000ff)',
    };
    const at = (left) =>
      e(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        e('box', {
          style: {
            position: 'absolute',
            left,
            top: BOX.y,
            width: BOX.width,
            height: BOX.height,
            ...style,
          },
        }),
      );
    const root = await mount(app, at(20));
    await root.rerender(at(120));
    const img = await shot(root);
    const mid = BOX.y + BOX.height / 2;
    near(img.at(121, mid)[0], 255, 12, 'red at the new left edge');
    near(img.at(120 + BOX.width - 2, mid)[2], 255, 12, 'blue at the new right');
    assert.deepEqual(img.at(21, mid), [255, 255, 255], 'and gone from the old');
  } finally {
    await app.close();
  }
});

test('$token colour stops resolve against the theme', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed(
        { backgroundImage: 'linear-gradient($from, $to)' },
        { theme: { from: '#ff0000', to: '#0000ff' } },
      ),
    );
    const img = await shot(root);
    const mid = BOX.x + BOX.width / 2;
    near(img.at(mid, BOX.y + 1)[0], 255, 12, 'the first token’s colour');
    near(img.at(mid, BOX.y + BOX.height - 2)[2], 255, 12, 'the second’s');
  } finally {
    await app.close();
  }
});

test('a translucent gradient composites over the backgroundColor', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed({
        backgroundColor: '#00ff00',
        // fully transparent at the top, opaque black at the bottom: the top
        // must still be the green underneath it
        backgroundImage: 'linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 1))',
      }),
    );
    const img = await shot(root);
    const mid = BOX.x + BOX.width / 2;
    near(img.at(mid, BOX.y + 1)[1], 255, 12, 'the colour shows through');
    assert.ok(
      img.ink(mid, BOX.y + BOX.height - 2) > 200,
      'and the opaque end covers it',
    );
  } finally {
    await app.close();
  }
});

// --- shadows ---------------------------------------------------------------

test('a blurred shadow is drawn outside the box and fades away', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed({ backgroundColor: '#ffffff', boxShadow: '0 0 10px #000000' }),
    );
    const mid = BOX.y + BOX.height / 2;
    const check = (img, when) => {
      const close = img.ink(BOX.x - 2, mid);
      const middling = img.ink(BOX.x - 7, mid);
      const far = img.ink(BOX.x - 14, mid);
      assert.ok(
        close > 40,
        `${when}: expected ink beside the box, got ${close}`,
      );
      assert.ok(
        close > middling && middling > far,
        `${when}: expected a falloff, got ${close} > ${middling} > ${far}`,
      );
      assert.equal(img.ink(BOX.x - 30, mid), 0, `${when}: nothing further out`);
      // the box's own background is over the top of it
      assert.deepEqual(
        img.at(BOX.x + 4, mid),
        [255, 255, 255],
        `${when}: the shadow is under the node, not over it`,
      );
    };
    check(await shot(root), 'painted live');

    // …and again once the paint cache is serving it. The blur lives on the
    // *picture*, not in the pixels, so a cached entry that lost its filter
    // would come back as a hard-edged rectangle — which is the one thing
    // about caching this drawing that is not like caching any other.
    for (let i = 0; i < 3; i++) {
      root.needsPaint = true;
      root._damage = null;
      root.flush();
      await settle(app);
    }
    assert.ok(root._paintCache?.stats.hits > 0, 'the cache took it');
    check(await shot(root), 'from the cache');
  } finally {
    await app.close();
  }
});

test('an offset shadow lands on the side it was offset to', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      // no blur: a hard rectangle, so the offset is exactly measurable
      boxed({ backgroundColor: '#ffffff', boxShadow: '8px 8px 0 #000000' }),
    );
    const img = await shot(root);
    assert.equal(
      img.ink(BOX.x + BOX.width + 4, BOX.y + BOX.height + 4),
      255,
      'solid ink down and to the right',
    );
    assert.equal(
      img.ink(BOX.x - 4, BOX.y - 4),
      0,
      'and nothing up and to the left',
    );
    assert.equal(
      img.ink(BOX.x + BOX.width + 9, BOX.y + BOX.height / 2),
      0,
      'the rectangle ends where the offset says',
    );
  } finally {
    await app.close();
  }
});

test('spread grows the shadow, blur or no blur', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed({ backgroundColor: '#ffffff', boxShadow: '0 0 0 6px #000000' }),
    );
    const img = await shot(root);
    const mid = BOX.y + BOX.height / 2;
    assert.equal(img.ink(BOX.x - 5, mid), 255, 'inside the spread');
    assert.equal(img.ink(BOX.x - 7, mid), 0, 'and outside it');
  } finally {
    await app.close();
  }
});

test('a shadow with no colour is drawn in the node’s own ink', async () => {
  // CSS's `currentColor`, resolved through the cascade — so a shadow named
  // once in a palette follows the text it sits under
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      boxed({
        backgroundColor: '#ffffff',
        color: '#ff0000',
        boxShadow: '0 0 0 4px',
      }),
    );
    const img = await shot(root);
    assert.deepEqual(
      img.at(BOX.x - 2, BOX.y + BOX.height / 2),
      [255, 0, 0],
      'the ring is the ink',
    );
  } finally {
    await app.close();
  }
});

test('a <window> takes a gradient too, damage-bounded like its colour', async () => {
  const app = await headlessApp();
  try {
    const root = await mount(
      app,
      e('window', {
        width: W,
        height: H,
        style: { backgroundImage: 'linear-gradient(#ff0000, #0000ff)' },
      }),
    );
    const img = await shot(root);
    near(img.at(W / 2, 1)[0], 255, 12, 'red at the top of the window');
    near(img.at(W / 2, H - 2)[2], 255, 12, 'blue at the bottom');
  } finally {
    await app.close();
  }
});

test('a shadow claims the pixels it paints, and the ones it stops painting', async () => {
  const app = await headlessApp();
  try {
    const ref = React.createRef();
    const root = await mount(
      app,
      e(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        e('box', {
          ref,
          style: {
            position: 'absolute',
            left: BOX.x,
            top: BOX.y,
            width: BOX.width,
            height: BOX.height,
            backgroundColor: '#ffffff',
            ':hover': { boxShadow: '0 0 12px #000000' },
          },
        }),
      ),
    );
    const node = ref.current;

    // the bound grows with the decoration, or the frame that draws it cuts
    // the shadow off at the node's own rect
    assert.equal(
      node.paintBounds().width,
      BOX.width + 2,
      'no shadow, no slack',
    );
    node.setStyleState(':hover', true);
    assert.ok(
      node.paintBounds().width > BOX.width + 20,
      `expected room for the blur, got ${node.paintBounds().width}`,
    );
    root.flush();
    await settle(app);
    const hovered = await shot(root);
    assert.ok(hovered.ink(BOX.x - 4, BOX.y + 40) > 20, 'the shadow is there');

    // …and taking it away repaints where it was. The claim is bounded — the
    // node's new bounds no longer contain the shadow — so this is the case
    // that leaves a printed ring around the box when nothing claims the old
    // extent (`_retarget`).
    node.setStyleState(':hover', false);
    root.flush();
    await settle(app);
    const partial = await shot(root);
    assert.ok(root._lastDamage, 'the frame stayed bounded');

    root.needsPaint = true;
    root._damage = null;
    root.flush();
    await settle(app);
    const full = await shot(root);
    assert.ok(
      partial.bytes.equals(full.bytes),
      'a bounded repaint must leave the surface a full one would',
    );
    assert.equal(partial.ink(BOX.x - 4, BOX.y + 40), 0, 'the shadow is gone');
  } finally {
    await app.close();
  }
});

test('identical shadows share one cached surface', async () => {
  const app = await headlessApp();
  try {
    const rows = Array.from({ length: 4 }, (_, i) =>
      e('box', {
        key: i,
        style: {
          position: 'absolute',
          left: 20,
          top: 20 + i * 40,
          width: 120,
          height: 24,
          backgroundColor: '#ffffff',
          boxShadow: '0 2px 6px #000000',
        },
      }),
    );
    const root = await mount(
      app,
      e(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        ...rows,
      ),
    );
    // the cache admits a key on its second sighting, so the second frame is
    // the one that renders and the third is all hits
    for (let i = 0; i < 3; i++) {
      root.needsPaint = true;
      root._damage = null;
      root.flush();
      await settle(app);
    }
    const cache = root._paintCache;
    assert.ok(cache, 'the in-process server supports the paint cache');
    const shadows = [...cache.entries.keys()].filter((k) =>
      k.startsWith('shadow|'),
    );
    assert.equal(shadows.length, 1, `four rows, one surface: ${shadows}`);
    assert.ok(cache.stats.hits >= 4, `expected reuse, got ${cache.stats.hits}`);
  } finally {
    await app.close();
  }
});
