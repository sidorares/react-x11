// The <svg> paint cache (issue #149): same drawing, one rendered copy.
//
// End-to-end, against node-x11's in-process X server, which implements Render
// compositing for real — so "it drew the right thing" is a pixel assertion and
// "it drew it from the cache" is a stats assertion, and both have to hold.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import ReactX11 from '../src/index.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { paintCacheSupported } from '../src/paintcache.js';

// The cache needs ntk's Surface, which lands in a later ntk than package.json
// pins; without it the renderer paints live and everything below is vacuous.
// Skipped with a reason rather than quietly passing — a green run that tested
// nothing is worse than a red one.
const skip = paintCacheSupported()
  ? false
  : 'needs ntk with Surface (sidorares/ntk#157) — the cache is inert without it';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 200;
const H = 200;

async function headlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

/** Mount a tree and return the root node plus a frame pump. */
async function mount(app, element) {
  const instance = await new Promise((resolve) =>
    ReactX11.render(element, resolve, app),
  );
  const root = instance._reactX11Node;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  await settle(app);
  return { root, frame };
}

/** Force a full repaint, the way an expose or a theme change does. */
async function repaint(app, ctl) {
  ctl.root.invalidate(true, null, 'expose');
  ctl.frame();
  await settle(app);
}

async function pixels(app, root) {
  const ctx = root._ctx;
  const image = await new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, W, H, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );
  return (x, y) => {
    const i = (y * W + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
}

const near = (rgb, want, tol = 24) =>
  rgb.every((c, i) => Math.abs(c - want[i]) <= tol);

// A filled square, so a pixel in the middle of a cell is unambiguously the
// drawing's colour rather than an antialiased edge.
const SQUARE = (paint) =>
  `<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="${paint}"/></svg>`;

const TWO_COLOUR =
  '<svg viewBox="0 0 10 10">' +
  '<rect width="10" height="5" fill="#ff0000"/>' +
  '<rect y="5" width="10" height="5" fill="#0000ff"/></svg>';

/** `count` cells of one drawing, laid out in a row. */
function wall(source, count, extra = {}) {
  return React.createElement(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' } },
    ...Array.from({ length: count }, (_, i) =>
      React.createElement('svg', {
        key: i,
        source,
        style: {
          position: 'absolute',
          left: i * 20,
          top: 0,
          width: 16,
          height: 16,
        },
        ...extra,
      }),
    ),
  );
}

test({ skip }, 'identical drawings share one rendered copy', async () => {
  const app = await headlessApp();
  const ctl = await mount(app, wall(SQUARE('#00aa00'), 5));
  const cache = ctl.root._paintCache;

  assert.ok(cache, 'the cache exists on an app that can make surfaces');
  assert.equal(cache.entries.size, 1, 'five cells, one entry');
  assert.equal(cache.stats.renders, 1, 'rendered once');

  // ...and every cell still shows the drawing
  const px = await pixels(app, ctl.root);
  for (let i = 0; i < 5; i++) {
    assert.ok(
      near(px(i * 20 + 8, 8), [0, 170, 0]),
      `cell ${i} painted: got ${px(i * 20 + 8, 8)}`,
    );
  }
  await app.close();
});

test({ skip }, 'a repaint of unchanged content is all hits', async () => {
  const app = await headlessApp();
  const ctl = await mount(app, wall(SQUARE('#00aa00'), 5));
  const cache = ctl.root._paintCache;
  const rendersAfterMount = cache.stats.renders;

  const hitsBefore = cache.stats.hits;
  await repaint(app, ctl);

  assert.equal(cache.stats.renders, rendersAfterMount, 'nothing re-rendered');
  assert.equal(cache.stats.hits - hitsBefore, 5, 'five cells, five hits');

  const px = await pixels(app, ctl.root);
  assert.ok(near(px(8, 8), [0, 170, 0]), `still painted: got ${px(8, 8)}`);
  await app.close();
});

test({ skip }, 'a drawing painted once is never cached', async () => {
  // the "seen twice" gate: a node painted once and never again is a pure loss
  const app = await headlessApp();
  const ctl = await mount(app, wall(SQUARE('#00aa00'), 1));
  assert.equal(ctl.root._paintCache.entries.size, 0);

  const px = await pixels(app, ctl.root);
  assert.ok(near(px(8, 8), [0, 170, 0]), 'and it still painted live');
  await app.close();
});

test(
  { skip },
  'a different document is a different entry, not a stale one',
  async () => {
    const app = await headlessApp();
    const ctl = await mount(app, wall(SQUARE('#00aa00'), 4));
    const cache = ctl.root._paintCache;
    assert.equal(cache.entries.size, 1);

    await new Promise((resolve) =>
      ReactX11.render(wall(SQUARE('#0000ff'), 4), resolve, app),
    );
    ctl.frame();
    await settle(app);

    assert.equal(cache.entries.size, 2, 'the old entry is not reused');
    const px = await pixels(app, ctl.root);
    assert.ok(near(px(8, 8), [0, 0, 255]), `repainted blue: got ${px(8, 8)}`);
    await app.close();
  },
);

test(
  { skip },
  'a monochrome drawing recolours without re-rendering',
  async () => {
    // the point of caching coverage rather than colour: one entry serves every
    // colour the UI asks for, so a hover or a theme flip is a composite
    const coloured = (colour) =>
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        ...Array.from({ length: 4 }, (_, i) =>
          React.createElement('svg', {
            key: i,
            source: SQUARE('currentColor'),
            style: {
              position: 'absolute',
              left: i * 20,
              top: 0,
              width: 16,
              height: 16,
              color: colour,
            },
          }),
        ),
      );

    const app = await headlessApp();
    const ctl = await mount(app, coloured('#ff0000'));
    const cache = ctl.root._paintCache;
    const entries = cache.entries.size;
    const renders = cache.stats.renders;
    let px = await pixels(app, ctl.root);
    assert.ok(near(px(8, 8), [255, 0, 0]), `red first: got ${px(8, 8)}`);

    await new Promise((resolve) =>
      ReactX11.render(coloured('#0000ff'), resolve, app),
    );
    ctl.frame();
    await settle(app);

    assert.equal(
      cache.entries.size,
      entries,
      'no new entry for the new colour',
    );
    assert.equal(cache.stats.renders, renders, 'and nothing re-rendered');
    px = await pixels(app, ctl.root);
    assert.ok(near(px(8, 8), [0, 0, 255]), `now blue: got ${px(8, 8)}`);
    await app.close();
  },
);

test(
  { skip },
  'a multi-colour drawing bakes its colours and keeps them',
  async () => {
    const app = await headlessApp();
    const ctl = await mount(app, wall(TWO_COLOUR, 4));
    const cache = ctl.root._paintCache;
    assert.equal(cache.entries.size, 1);

    const px = await pixels(app, ctl.root);
    assert.ok(near(px(8, 3), [255, 0, 0]), `top half red: got ${px(8, 3)}`);
    assert.ok(
      near(px(8, 13), [0, 0, 255]),
      `bottom half blue: got ${px(8, 13)}`,
    );

    await repaint(app, ctl);
    const after = await pixels(app, ctl.root);
    assert.ok(
      near(after(8, 3), [255, 0, 0]),
      'still red after a cached repaint',
    );
    assert.ok(near(after(8, 13), [0, 0, 255]), 'still blue');
    await app.close();
  },
);

test(
  { skip },
  'a drawing too big to be worth caching paints live',
  async () => {
    const app = await headlessApp();
    const big = {
      position: 'absolute',
      left: 0,
      top: 0,
      width: 400,
      height: 400,
    };
    const ctl = await mount(
      app,
      React.createElement(
        'window',
        { width: W, height: H },
        ...Array.from({ length: 3 }, (_, i) =>
          React.createElement('svg', {
            key: i,
            source: SQUARE('#00aa00'),
            style: big,
          }),
        ),
      ),
    );
    const cache = ctl.root._paintCache;
    assert.equal(cache.entries.size, 0, '400x400 is past the per-item cap');
    assert.ok(cache.stats.tooBig > 0, 'and it says so');
    await app.close();
  },
);

// --- verify mode -----------------------------------------------------------
//
// A key that fails to name something the paint reads is the one way this
// design produces a *wrong* pixel rather than a slow frame, and it is the
// failure that is hardest to spot by looking. So the mechanism that catches it
// gets tested against a node that really does lie.

/** A node implementing the protocol, whose drawing can be changed underneath
 * a fixed key — exactly the mistake an implementor makes. */
function lyingNode(colours) {
  let call = 0;
  return {
    kind: 'liar',
    live: 0,
    paintCachePlan: () => ({
      key: 'liar|16x16', // never mentions the colour
      x: 0,
      y: 0,
      width: 16,
      height: 16,
      format: 'argb32',
      tint: null,
    }),
    paintCached(ctx, box) {
      ctx.fillStyle = colours[Math.min(call++, colours.length - 1)];
      ctx.fillRect(box.x, box.y, box.width, box.height);
    },
    _paintContent() {
      this.live++;
    },
  };
}

async function drive(cache, node, ctx, times) {
  for (let i = 0; i < times; i++) {
    cache.beginFrame();
    cache.paint(node, ctx);
    cache.endFrame();
  }
}

test(
  { skip },
  'verify mode says nothing when the key tells the truth',
  async () => {
    const app = await headlessApp();
    const { PaintCache } = await import('../src/paintcache.js');
    const cache = new PaintCache(app, { verify: true });
    const ctx = app
      .createPixmap({ width: 32, height: 32, depth: 32 })
      .getContext('2d');

    const errors = [];
    const real = console.error;
    console.error = (...a) => errors.push(a.join(' '));
    try {
      // one colour forever: the drawing really is a function of the key
      await drive(cache, lyingNode(['#00aa00']), ctx, 4);
    } finally {
      console.error = real;
    }
    assert.equal(cache.stats.hits, 2, 'gate, render, then two hits');
    assert.deepEqual(errors, [], 'and no complaint');
    await app.close();
  },
);

test({ skip }, 'verify mode catches a key that misses an input', async () => {
  const app = await headlessApp();
  const { PaintCache } = await import('../src/paintcache.js');
  const cache = new PaintCache(app, { verify: true });
  const ctx = app
    .createPixmap({ width: 32, height: 32, depth: 32 })
    .getContext('2d');

  const errors = [];
  const real = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    // the third paint draws a different colour under the same key
    await drive(cache, lyingNode(['#00aa00', '#00aa00', '#ff0000']), ctx, 4);
  } finally {
    console.error = real;
  }

  assert.ok(errors.length > 0, 'the lie is reported');
  assert.match(errors[0], /does not cover the paint/);
  assert.match(errors[0], /liar\|16x16/, 'and it names the key');
  await app.close();
});

test({ skip }, 'verify mode is off unless asked for', async () => {
  const app = await headlessApp();
  const { PaintCache } = await import('../src/paintcache.js');
  const cache = new PaintCache(app);
  const ctx = app
    .createPixmap({ width: 32, height: 32, depth: 32 })
    .getContext('2d');

  const errors = [];
  const real = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    await drive(cache, lyingNode(['#00aa00', '#00aa00', '#ff0000']), ctx, 4);
  } finally {
    console.error = real;
  }
  // the same lie, unreported — which is why the mode exists
  assert.deepEqual(errors, []);
  await app.close();
});

test('the kill switch turns the whole thing off', async () => {
  // Stale pixels are the failure this cannot debug its way out of, so there
  // has to be a way to take it out of the picture — same as NO_SCROLL_BLIT.
  process.env.REACT_X11_NO_PAINT_CACHE = '1';
  try {
    // a fresh module instance, so the flag is read again at load
    const { paintCacheFor } = await import('../src/paintcache.js?killswitch');
    const app = await headlessApp();
    assert.equal(paintCacheFor(app), null);
    await app.close();
  } finally {
    delete process.env.REACT_X11_NO_PAINT_CACHE;
  }
});

test('an app that cannot make surfaces gets no cache, and no crash', async () => {
  // the headless mock in the smoke tests has no Render extension
  const { paintCacheFor } = await import('../src/paintcache.js');
  assert.equal(paintCacheFor({ display: {} }), null);
  assert.equal(paintCacheFor(null), null);
});

// --- other implementors ----------------------------------------------------

test(
  { skip },
  '<canvas cacheKey> is opt-in, and caches when opted in',
  async () => {
    const app = await headlessApp();
    let draws = 0;
    const onDraw = (ctx, { width, height }) => {
      draws++;
      ctx.fillStyle = '#00aa00';
      ctx.fillRect(0, 0, width, height);
    };
    const cells = (props) =>
      React.createElement(
        'window',
        { width: W, height: H, style: { backgroundColor: '#ffffff' } },
        ...Array.from({ length: 4 }, (_, i) =>
          React.createElement('canvas', {
            key: i,
            onDraw,
            style: {
              position: 'absolute',
              left: i * 20,
              top: 0,
              width: 16,
              height: 16,
            },
            ...props,
          }),
        ),
      );

    // without a key: every cell runs onDraw, every frame
    const ctl = await mount(app, cells({}));
    assert.equal(ctl.root._paintCache.entries.size, 0);
    assert.equal(draws, 4);

    await new Promise((resolve) =>
      ReactX11.render(cells({ cacheKey: 'green:16x16' }), resolve, app),
    );
    ctl.frame();
    await settle(app);
    const cache = ctl.root._paintCache;
    assert.equal(cache.entries.size, 1, 'four cells, one entry');

    const drawsAfter = draws;
    await repaint(app, ctl);
    assert.equal(draws, drawsAfter, 'a cached repaint runs no onDraw at all');

    const px = await pixels(app, ctl.root);
    assert.ok(near(px(8, 8), [0, 170, 0]), `and painted: got ${px(8, 8)}`);
    await app.close();
  },
);

test({ skip }, 'the same formula twice is one <tex> entry', async () => {
  const app = await headlessApp();
  const formula = (props) =>
    React.createElement(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      ...Array.from({ length: 3 }, (_, i) =>
        React.createElement('tex', {
          key: i,
          source: 'x^2',
          style: { position: 'absolute', left: 4, top: i * 40 },
          ...props,
        }),
      ),
    );
  const ctl = await mount(app, formula({}));
  const cache = ctl.root._paintCache;
  // TexBox memoizes its *layout* per node, so without this each of the three
  // rasterized itself on every frame
  assert.equal(cache.entries.size, 1, 'three copies, one rendered');

  const renders = cache.stats.renders;
  await repaint(app, ctl);
  assert.equal(cache.stats.renders, renders, 'and a repaint re-renders none');
  await app.close();
});
