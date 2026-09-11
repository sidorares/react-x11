// A `position` of your own: a positioning scheme registered from outside core
// that lays its node out in flow and then moves it — the seam
// `position: 'sticky'` itself is written against (src/layouts.js,
// docs/extending.md "A position of your own"). Like the sticky tests, these
// read `abs` right after the frame that changed something: the pass that
// places runs inside that frame, so there is no later one for the answer to
// arrive in.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import {
  registerPosition,
  unregisterPosition,
  registeredPositions,
} from '../src/host.js';
import { setAnimationClock } from '../src/nodes/animation.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frame = () => tick().then(tick);

async function mount(children, { width = 200, height = 100, scale } = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app, ...(scale && { scale }) });
  const render = (kids) => x11Root.render(h('window', { width, height }, kids));
  render(children);
  await frame();
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, x11Root, render };
}

/** The frame, now, the way the clock would run it — so what is asserted next
 *  is *that* frame's answer and not a later one's. */
function flushNow(root) {
  root._scheduled = false;
  root.flush();
}

// Each test registers under its own names and takes them away after, so no
// definition leaks into the next test's expectations.
const defined = [];
function define(name, definition) {
  registerPosition(name, definition);
  defined.push(name);
}
afterEach(() => {
  for (const name of defined.splice(0)) unregisterPosition(name);
  setAnimationClock(() => Date.now());
});

/** console.error, captured. A reported problem also marks the process
 *  failed, which a test that provokes one on purpose has to put back. */
async function capturingErrors(fn) {
  const lines = [];
  const original = console.error;
  const code = process.exitCode;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    await fn(lines);
  } finally {
    console.error = original;
    process.exitCode = code;
  }
  return lines;
}

const at = (node) => ({ x: node.abs.x, y: node.abs.y });
const row = (ref, style) =>
  h('box', { ref, style: { height: 20, flexShrink: 0, ...style } });

test('registerPosition says what is wrong with a definition', () => {
  assert.throws(
    () => registerPosition('', { place() {} }),
    /a name is letters/,
  );
  assert.throws(
    () => registerPosition('2up', { place() {} }),
    /not starting with a digit/,
  );
  assert.throws(
    () => registerPosition('nothing', {}),
    /needs a place\(node, context\) function/,
  );
  for (const name of ['sticky', 'relative', 'absolute', 'static', 'fixed']) {
    assert.throws(
      () => registerPosition(name, { place() {} }),
      /one of CSS's own positions/,
      name,
    );
  }
  assert.throws(
    () =>
      registerPosition('typed', {
        place() {},
        options: { rate: { type: 'float' } },
      }),
    /option "rate" has type "float"/,
  );
  assert.throws(
    () =>
      registerPosition('typed', {
        place() {},
        options: { rate: { type: 'number', default: 'fast' } },
      }),
    /defaults to "fast", which is not a number/,
  );
  assert.ok(
    !registeredPositions().includes('typed'),
    'nothing half-registered',
  );
});

test('the same definition twice is one definition; a different one is a conflict', () => {
  const place = () => null;
  define('twice', { place });
  registerPosition('twice', { place });
  assert.throws(
    () => registerPosition('twice', { place: () => null }),
    /"twice" is already registered/,
  );
  registerPosition('twice', { place: () => ({ x: 1, y: 1 }), override: true });
  assert.ok(registeredPositions().includes('twice'));
  assert.strictEqual(unregisterPosition('twice'), true);
  assert.strictEqual(unregisterPosition('twice'), false);
});

test('a position moves a node from where layout put it, in the frame that laid out', async () => {
  define('nudge', { place: () => ({ x: 5, y: 7 }) });
  const node = React.createRef();
  await mount(
    h(
      'box',
      { style: { padding: 10 } },
      row(node, { marginTop: 4, position: 'nudge' }),
    ),
  );
  assert.deepStrictEqual(at(node.current), { x: 15, y: 21 });
});

test('it runs in the frame a scroll runs: a layer moving at half the scroll', async () => {
  define('parallax', {
    options: { rate: { type: 'number', default: 0.5 } },
    place: (node, { pane, options }) =>
      pane ? { x: 0, y: Math.round(pane.scrollY * options.rate) } : null,
  });
  const pane = React.createRef();
  const layer = React.createRef();
  const { root } = await mount(
    h(
      'box',
      { ref: pane, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', {
        ref: layer,
        style: { height: 40, flexShrink: 0, position: 'parallax' },
      }),
      h('box', { style: { height: 400, flexShrink: 0 } }),
    ),
  );
  assert.strictEqual(layer.current.abs.y, 0);
  pane.current.scrollTo(60);
  flushNow(root);
  // laid out 60 up by the scroll and moved 30 back by the placement — in the
  // very frame that scrolled
  assert.strictEqual(layer.current.abs.y, -30);
  pane.current.scrollTo(100);
  flushNow(root);
  assert.strictEqual(layer.current.abs.y, -50);
});

test('what a position is handed: window coordinates in device pixels, options resolved', async () => {
  const seen = [];
  define('spy', {
    options: {
      distance: { type: 'length', default: 3 },
      label: { type: 'string', default: 'x' },
    },
    place: (node, context) => {
      seen.push({ node, context });
      return null;
    },
  });
  setAnimationClock(() => 1234);
  const pane = React.createRef();
  const target = React.createRef();
  await mount(
    h(
      'box',
      {
        ref: pane,
        style: {
          overflow: 'scroll',
          flexGrow: 1,
          borderWidth: 2,
          borderColor: '#000000',
          padding: 3,
        },
      },
      h(
        'box',
        { style: { padding: 5, flexShrink: 0 } },
        h('box', {
          ref: target,
          style: {
            height: 10,
            flexShrink: 0,
            margin: 4,
            position: { name: 'spy', distance: 6 },
          },
        }),
      ),
      h('box', { style: { height: 400, flexShrink: 0 } }),
    ),
    { scale: 2 },
  );
  pane.current.scrollTo(10);
  await frame();
  const { node, context } = seen.at(-1);
  assert.ok(node === target.current, 'the node itself');
  assert.strictEqual(context.scale, 2);
  assert.strictEqual(context.now, 1234, 'the frame clock');
  assert.strictEqual(context.direction, 'ltr');
  assert.deepStrictEqual(
    context.options,
    { distance: 12, label: 'x' },
    'lengths in device pixels, defaults filled in',
  );
  assert.deepStrictEqual(context.margin, {
    left: 8,
    top: 8,
    right: 8,
    bottom: 8,
  });
  // the pane's scrollport: inside its border (2 → 4 device pixels), over its
  // padding, in a 400x200 device window
  assert.deepStrictEqual(context.pane.scrollport, {
    left: 4,
    top: 4,
    right: 396,
    bottom: 196,
  });
  assert.strictEqual(context.pane.scrollY, 20, 'device pixels, like abs');
  // border 4 + padding 6 + the inner box's padding 10 + margin 8, and the
  // 20 the pane has scrolled
  const inset = 4 + 6 + 10 + 8;
  assert.deepStrictEqual(context.laidOut, {
    x: inset,
    y: inset - 20,
    width: 400 - 2 * inset,
    height: 20,
  });
  const parent = target.current.parent;
  assert.deepStrictEqual(context.container, {
    left: parent.abs.x + 10,
    top: parent.abs.y + 10,
    right: parent.abs.x + parent.abs.width - 10,
    bottom: parent.abs.y + parent.abs.height - 10,
  });
});

test('the insets are the position’s to read, never offsets', async () => {
  const seen = [];
  define('probe', {
    place: (node) => {
      seen.push({ top: node.style.top, left: node.style.left });
      return null;
    },
  });
  const node = React.createRef();
  await mount(row(node, { position: 'probe', top: 30, left: 7 }));
  assert.deepStrictEqual(
    at(node.current),
    { x: 0, y: 0 },
    'yoga never saw them',
  );
  assert.deepStrictEqual(seen.at(-1), { top: 30, left: 7 }, 'the scheme did');
});

test('null leaves it where layout put it; a style that stops asking puts it back and lets go', async () => {
  let offset = { x: 0, y: 12 };
  define('maybe', { place: () => offset });
  const node = React.createRef();
  const tree = (position) => row(node, position ? { position } : {});
  const { root, render } = await mount(tree('maybe'));
  assert.strictEqual(node.current.abs.y, 12);
  offset = null;
  root.invalidate(true, null, 'props');
  await frame();
  assert.strictEqual(node.current.abs.y, 0, 'null is where layout put it');
  offset = { x: 0, y: 12 };
  root.invalidate(true, null, 'props');
  await frame();
  assert.strictEqual(node.current.abs.y, 12);
  render(tree(null));
  await frame();
  assert.strictEqual(node.current.abs.y, 0, 'back in flow');
  assert.strictEqual(root._placedNodes.size, 0, 'and let go');
});

test('new options move it in the next frame; the same options again cost no pass', async () => {
  define('down', {
    options: { by: { type: 'length', default: 0 } },
    place: (node, { options }) => ({ x: 0, y: options.by }),
  });
  const node = React.createRef();
  const tree = (by) => row(node, { position: { name: 'down', by } });
  const { root, render } = await mount(tree(10));
  assert.strictEqual(node.current.abs.y, 10);
  render(tree(25));
  await frame();
  assert.strictEqual(node.current.abs.y, 25);
  const passes = root._layoutPasses;
  // an inline object is a new one every render, asking for the same thing
  render(tree(25));
  await frame();
  assert.strictEqual(
    root._layoutPasses,
    passes,
    'no layout pass for an equal position',
  );
});

test('a position nobody registered is reported once, and the node lays out in flow', async () => {
  const node = React.createRef();
  const lines = await capturingErrors(async () => {
    const { render } = await mount(row(node, { position: 'nope', top: 20 }));
    assert.strictEqual(node.current.abs.y, 0, 'in flow, the insets withheld');
    render(row(node, { position: 'nope', top: 20 }));
    await frame();
  });
  assert.strictEqual(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /position "nope" is neither CSS's/);
  assert.match(lines[0], /'absolute', 'sticky'/);
  assert.match(lines[0], /laid out in flow, as relative is/);
});

test('fixed says what to do instead', async () => {
  const lines = await capturingErrors(async () => {
    await mount(row(null, { position: 'fixed' }));
  });
  assert.match(
    lines.join('\n'),
    /position: 'fixed' is not supported — a <popup>/,
  );
});

test('a wrong option is reported and takes its default; an unknown one is named', async () => {
  const seen = [];
  define('rated', {
    options: { rate: { type: 'number', default: 1 } },
    place: (node, { options }) => {
      seen.push(options);
      return null;
    },
  });
  const lines = await capturingErrors(async () => {
    await mount([
      h('box', {
        key: 'a',
        style: {
          height: 20,
          flexShrink: 0,
          position: { name: 'rated', rate: 'fast' },
        },
      }),
      h('box', {
        key: 'b',
        style: {
          height: 20,
          flexShrink: 0,
          position: { name: 'rated', speed: 2 },
        },
      }),
    ]);
  });
  assert.ok(
    seen.length > 0 && seen.every((o) => o.rate === 1),
    JSON.stringify(seen),
  );
  const all = lines.join('\n');
  assert.match(all, /option "rate" is "fast", where it takes a number/);
  assert.match(all, /unknown option "speed" \(it takes "rate"\)/);
});

test('a position that throws is reported, and not asked again until the style names another', async () => {
  let calls = 0;
  define('broken', {
    place: () => {
      calls += 1;
      throw new Error('kaboom');
    },
  });
  define('fine', { place: () => ({ x: 0, y: 3 }) });
  const node = React.createRef();
  const tree = (position) => row(node, { position });
  const lines = await capturingErrors(async () => {
    const { root, render } = await mount(tree('broken'));
    root.invalidate(true, null, 'props');
    await frame();
    assert.strictEqual(calls, 1, 'asked once');
    assert.strictEqual(node.current.abs.y, 0, 'where layout put it');
    render(tree('fine'));
    await frame();
    assert.strictEqual(node.current.abs.y, 3);
    render(tree('broken'));
    await frame();
    assert.strictEqual(calls, 2, 'named again, asked again');
  });
  const reports = lines.filter((l) =>
    l.includes('position "broken" on <box> threw'),
  );
  assert.strictEqual(reports.length, 2, lines.join('\n'));
  assert.match(reports[0], /kaboom/);
});

test('again: true runs the next frame with nothing to lay out, and stops when it stops asking', async () => {
  let t = 0;
  setAnimationClock(() => t);
  define('slide', {
    place: (node, { now }) => {
      const y = Math.min(now, 40);
      return { x: 0, y, again: y < 40 };
    },
  });
  const node = React.createRef();
  const { root } = await mount(row(node, { position: 'slide' }));
  assert.strictEqual(node.current.abs.y, 0);
  const passes = root._layoutPasses;
  t = 25;
  await frame();
  assert.strictEqual(node.current.abs.y, 25);
  t = 60;
  await frame();
  assert.strictEqual(node.current.abs.y, 40, 'it arrived');
  assert.strictEqual(
    root._layoutPasses,
    passes,
    'with nothing laid out to get there',
  );
  await frame();
  assert.strictEqual(
    root._placementsDue,
    false,
    'and no frame is owed any more',
  );
});

test('a placed node paints over its later siblings and takes the press there', async () => {
  define('lower', { place: () => ({ x: 0, y: 30 }) });
  const moved = React.createRef();
  const under = React.createRef();
  const { root } = await mount([
    h('box', {
      key: 'a',
      ref: moved,
      style: { height: 20, flexShrink: 0, position: 'lower' },
    }),
    h('box', { key: 'b', ref: under, style: { height: 60, flexShrink: 0 } }),
  ]);
  // moved to y 30..50, over its later sibling
  const order = root.paintOrder();
  // by identity, never strictEqual: a failing diff of two nodes walks the
  // whole retained tree before it says anything
  assert.ok(order.at(-1) === moved.current, 'painted last');
  assert.ok(
    under.current.containsPoint(10, 40),
    'the sibling is under it there',
  );
  assert.ok(root.hitTest(10, 40) === moved.current, 'and it takes the press');
});

// --- the pixels, against the real ntk and an in-process X server ----------

const require = createRequire(import.meta.url);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(
    readFileSync(
      join(
        dirname(require.resolve('katex/package.json')),
        'dist',
        'fonts',
        'KaTeX_Main-Regular.ttf',
      ),
    ),
    { family: 'Test Main' },
  );
  fontSource.alias('sans-serif', 'Test Main');
  return await createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

test('an animated position leaves no trail: each frame claims where it was and where it went', async () => {
  let t = 0;
  setAnimationClock(() => t);
  define('glide', {
    place: (node, { now }) => {
      const x = Math.min(now, 120);
      return { x, y: 0, again: x < 120 };
    },
  });
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 200, height: 60, style: { backgroundColor: '#ffffff' } },
          h('box', {
            style: {
              width: 40,
              height: 40,
              flexShrink: 0,
              backgroundColor: '#c0392b',
              position: 'glide',
            },
          }),
        ),
        resolve,
      ),
    );
    const root = instance._reactX11Node;
    const paint = () => {
      root._scheduled = false;
      root.flush();
    };
    paint();
    await settle(app);
    const passes = root._layoutPasses;
    for (const when of [30, 60, 90, 120]) {
      t = when;
      paint();
      await settle(app);
    }
    assert.strictEqual(root._layoutPasses, passes, 'placement frames only');
    const pixels = await readPixels(root._ctx, 200, 60);
    const rgb = (x, y) => {
      const i = (y * 200 + x) * 4;
      return [...pixels.data.slice(i, i + 3)];
    };
    assert.deepStrictEqual(rgb(130, 20), [0xc0, 0x39, 0x2b], 'where it went');
    assert.deepStrictEqual(
      rgb(20, 20),
      [255, 255, 255],
      'where it started, erased',
    );
    assert.deepStrictEqual(
      rgb(100, 20),
      [255, 255, 255],
      'and the frame before',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});
