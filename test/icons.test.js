// The system icon set, and the `<canvas mono>` coverage path it rides on.
//
// The claims worth a test are the two the set was built for: one rendered
// copy of a glyph serves every colour it is ever asked for, and a re-render
// that changes nothing about a glyph damages nothing. Both are end-to-end,
// against node-x11's in-process X server, which composites Render for real —
// so the colour assertion is a pixel read and the sharing assertion is the
// cache's own stats.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import { createRoot, Icon, icons, iconNames, iconSize } from '../src/index.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 200;
const H = 200;
const h = React.createElement;

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

async function mount(app, element) {
  const x11Root = await createRoot({ app });
  const instance = await new Promise((resolve) =>
    x11Root.render(element, resolve),
  );
  const root = instance._reactX11Node;
  root._x11Root = x11Root;
  const frame = () => {
    root._scheduled = false;
    root.flush();
  };
  frame();
  await settle(app);
  return { root, frame, x11Root };
}

/** Re-render into the same root, then pump a frame. */
async function rerender(app, ctl, element) {
  await new Promise((resolve) => ctl.x11Root.render(element, resolve));
  ctl.frame();
  await settle(app);
}

async function pixels(app, root) {
  const image = await new Promise((resolve, reject) =>
    root._ctx.getImageData(0, 0, W, H, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );
  return (x, y) => {
    const i = (y * W + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
}

/** Every node in the tree, in paint order. */
function walk(root, out = []) {
  out.push(root);
  for (const c of root.children) if (!c.isWindow) walk(c, out);
  return out;
}

const canvases = (root) => walk(root).filter((n) => n.kind === 'canvas');

/** Cells of one icon laid out in a row, one colour each. */
const row = (name, colours, size = 16) =>
  h(
    'window',
    { width: W, height: H, style: { backgroundColor: '#ffffff' } },
    ...colours.map((color, i) =>
      h(Icon, {
        key: i,
        name,
        size,
        color,
        style: { position: 'absolute', left: i * 20, top: 0 },
      }),
    ),
  );

test('one rendered copy serves every colour', async () => {
  // The whole reason `mono` exists. Four cells of the same chevron in four
  // inks: the coverage is rendered once and the colour arrives at blit
  // time, so a hovered row, a disabled one and a dark scheme all reuse it.
  const app = await headlessApp();
  const ctl = await mount(
    app,
    row('chevronDown', ['#cc0000', '#0000cc', '#00aa00', '#aa00aa']),
  );
  const cache = ctl.root._paintCache;

  assert.ok(cache, 'the cache exists on an app that can make surfaces');
  assert.equal(cache.entries.size, 1, 'four colours, one entry');
  assert.equal(cache.stats.renders, 1, 'rasterized once');

  const [entry] = cache.entries.values();
  assert.equal(entry.surface.format, 'a8', 'kept as coverage, not as pixels');

  await app.close();
});

test('and each cell is painted in its own colour', async () => {
  // Sharing an entry is only right if the tint still lands: a chevron drawn
  // once and blitted four times has to come out red, blue, green, purple.
  const app = await headlessApp();
  const ctl = await mount(
    app,
    row('dot', ['#cc0000', '#0000cc', '#00aa00', '#aa00aa'], 16),
  );

  const px = await pixels(app, ctl.root);
  const want = [
    [204, 0, 0],
    [0, 0, 204],
    [0, 170, 0],
    [170, 0, 170],
  ];
  // the centre of each disc, which is solid coverage rather than an edge
  for (let i = 0; i < want.length; i++) {
    const got = px(i * 20 + 8, 8);
    assert.ok(
      got.every((c, k) => Math.abs(c - want[i][k]) <= 24),
      `cell ${i}: got ${got}, wanted ${want[i]}`,
    );
  }
  await app.close();
});

test('the colour is out of the key, the name and the size are in it', async () => {
  const app = await headlessApp();
  const ctl = await mount(app, row('check', ['#cc0000', '#0000cc']));
  const [key] = [...ctl.root._paintCache.entries.keys()];

  assert.match(key, /\bmono\b/, 'planned as coverage');
  assert.match(key, /check/, 'the name is in the key');
  assert.match(key, /16x16/, 'and the size it was drawn at');
  assert.ok(
    !key.includes('cc0000') && !key.includes('0000cc'),
    `the colour must not be in the key: ${key}`,
  );
  await app.close();
});

test('two sizes of one icon are two entries', async () => {
  // The counterpart: a coverage surface is pixels at a fixed size, so the
  // size cannot leave the key the way the colour does.
  const app = await headlessApp();
  const ctl = await mount(
    app,
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      ...[10, 10, 20, 20].map((size, i) =>
        h(Icon, {
          key: i,
          name: 'close',
          size,
          style: { position: 'absolute', left: i * 30, top: 0 },
        }),
      ),
    ),
  );
  assert.equal(ctl.root._paintCache.entries.size, 2, '10px and 20px');
  await app.close();
});

test('a plain <canvas> still caches as pixels', async () => {
  // `mono` is opt-in, and the drawings that bake their own colours have to
  // keep doing so — this is the shared code path's regression guard.
  const app = await headlessApp();
  const draw = (ctx, { width, height }) => {
    ctx.fillStyle = '#00aa00';
    ctx.fillRect(0, 0, width, height);
  };
  const ctl = await mount(
    app,
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      ...[0, 1].map((i) =>
        h('canvas', {
          key: i,
          cacheKey: 'plain',
          onDraw: draw,
          style: {
            position: 'absolute',
            left: i * 20,
            top: 0,
            width: 16,
            height: 16,
          },
        }),
      ),
    ),
  );
  const [entry] = ctl.root._paintCache.entries.values();
  assert.equal(entry.surface.format, 'argb32', 'colours baked in, as before');
  await app.close();
});

test('re-rendering an unchanged icon damages nothing', async () => {
  // The drawings are module-level, so `onDraw` keeps its identity across
  // renders and `CanvasNode.applyProps` has nothing to invalidate. Before
  // the set, every glyph was a fresh closure per render — a Tree of 500
  // rows re-damaged 500 canvases for icons that had not changed.
  const app = await headlessApp();
  const tree = (label) =>
    h(
      'window',
      { width: W, height: H },
      h(
        'box',
        { style: { flexDirection: 'row', gap: 4 } },
        h(Icon, { name: 'chevronRight', size: 12 }),
        h('text', null, label),
      ),
    );
  const ctl = await mount(app, tree('one'));
  const [icon] = canvases(ctl.root);

  let damaged = 0;
  const realInvalidate = ctl.root.invalidate.bind(ctl.root);
  ctl.root.invalidate = (full, node, why) => {
    if (node === icon) damaged++;
    return realInvalidate(full, node, why);
  };

  await rerender(app, ctl, tree('two'));
  assert.equal(damaged, 0, 'the label changed, the chevron did not');

  await rerender(
    app,
    ctl,
    h(
      'window',
      { width: W, height: H },
      h(
        'box',
        { style: { flexDirection: 'row', gap: 4 } },
        h(Icon, { name: 'chevronDown', size: 12 }),
        h('text', null, 'two'),
      ),
    ),
  );
  assert.ok(damaged > 0, 'and a different glyph does repaint');
  await app.close();
});

test('an unknown name is a loud mistake', () => {
  // A typo should not quietly render an empty box: the set is closed, and
  // the names are the API. Checked before the hook, so it is reachable
  // without a tree.
  assert.throws(() => Icon({ name: 'sparkles' }), {
    message: /not a system icon.*chevronRight/s,
  });
});

test('the set is affordances, and every name draws', () => {
  assert.deepEqual(
    [...iconNames].sort(),
    [
      'check',
      'chevronDown',
      'chevronLeft',
      'chevronRight',
      'chevronUp',
      'close',
      'dash',
      'dot',
      'eye',
      'eyeOff',
      'moreVertical',
      'plus',
    ],
    'the set is closed — a noun added here is a review comment',
  );

  // Every drawing has to work in the box it is handed and must never name a
  // colour: under `mono` the ink is preset, and a drawing that overrode it
  // would collide with itself in the cache.
  for (const name of iconNames) {
    const calls = [];
    const ctx = new Proxy(
      {},
      {
        get: (_, prop) => {
          if (prop === 'fillStyle' || prop === 'strokeStyle') return '#000000';
          return (...args) => calls.push([prop, args]);
        },
        set: (_, prop) => {
          calls.push(['set:' + String(prop), []]);
          return true;
        },
      },
    );
    icons[name](ctx, { width: 16, height: 16 });
    assert.ok(calls.length > 0, `${name} drew nothing`);
    const painted = calls.some(([m]) => m === 'stroke' || m === 'fill');
    assert.ok(painted, `${name} built a path but never painted it`);
    const colours = calls.filter(
      ([m]) => m === 'set:fillStyle' || m === 'set:strokeStyle',
    );
    assert.equal(colours.length, 0, `${name} must not set its own colour`);
  }
});

test('the ink fills the box — `size` is the mark', async () => {
  // The regression this pins: the glyphs were first drawn on lucide's grid,
  // where the ink is about 58% of the box and a chevron a quarter of it. Every
  // call site here picks `size` as *how big the mark should be* — a Select's
  // chevron matches the capitals beside it — so the grid convention made all
  // of them about 40% too small, and it does not show up in any assertion
  // about layout or caching. Measured off the pixels for that reason.
  const app = await headlessApp();
  const S = 32;
  const ctl = await mount(
    app,
    h(
      'window',
      { width: W, height: H, style: { backgroundColor: '#ffffff' } },
      h(Icon, {
        name: 'chevronDown',
        size: S,
        color: '#000000',
        style: { position: 'absolute', left: 0, top: 0 },
      }),
      h(Icon, {
        name: 'close',
        size: S,
        color: '#000000',
        style: { position: 'absolute', left: 50, top: 0 },
      }),
    ),
  );
  const px = await pixels(app, ctl.root);

  /** The painted bounds of a glyph drawn at `left`, in its own box. */
  const inked = (left) => {
    let x0 = S,
      y0 = S,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const [r, g, b] = px(left + x, y);
        if (r + g + b > 600) continue; // white background
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
  };

  const chevron = inked(0);
  // A chevron's arms are 45°, so it is as wide as its box and half as tall.
  assert.ok(
    chevron.w >= S * 0.9,
    `chevron should span its box: ${chevron.w} of ${S}`,
  );
  assert.ok(
    chevron.h >= S * 0.42 && chevron.h <= S * 0.62,
    `and stand half as tall: ${chevron.h} of ${S}`,
  );

  // Everything else fills both axes; `close` is inset a little because an X
  // reaching the corners measures longer on the diagonal than anything else
  // in the set measures on its side.
  const x = inked(50);
  assert.ok(
    x.w >= S * 0.72 && x.h >= S * 0.72,
    `close should fill its box: ${x.w}x${x.h} of ${S}`,
  );
  await app.close();
});

test('iconSize follows the type', () => {
  assert.equal(iconSize(14), 12, 'the 12px gutter the menu was built around');
  assert.ok(iconSize(20) > iconSize(14), 'and it scales with the palette');
});

test('the widgets draw from the set', async () => {
  // Stage 2: no widget keeps a glyph of its own, and none of them is a text
  // mark any more — `▸` and `✓` are tofu on a machine without them, which
  // is the warning docs/components.md gives applications.
  const app = await headlessApp();
  const { Select, Tree, Checkbox } = await import('../src/index.js');
  const ctl = await mount(
    app,
    h(
      'window',
      { width: W, height: H },
      h(Select, { options: ['Blue', 'Red'], value: 'Blue', onChange() {} }),
      h(Checkbox, { checked: true, onChange() {} }, 'on'),
      h(Tree, {
        items: [{ id: 'a', label: 'src', children: [{ id: 'b', label: 'x' }] }],
      }),
    ),
  );

  const drawn = canvases(ctl.root);
  assert.ok(drawn.length >= 3, `expected the widgets to draw glyphs`);
  for (const node of drawn) {
    assert.equal(node.props.mono, true, `a widget glyph that is not mono`);
    assert.ok(
      iconNames.includes(node.props.cacheKey),
      `a widget glyph outside the set: ${node.props.cacheKey}`,
    );
  }
  await app.close();
});
