// The paint cache on the Cocoa backend (#442, item 5): the same cache as
// X11's (test/paint-cache.test.js) over `CocoaSurface` instead of a pixmap,
// reached through `react-x11/ntk`'s `Surface`. Over a fake bridge, like
// cocoa-frames.test.js: what reaches the natives is the whole of what the
// glue decides, and the cache's own stats say what it did.
//
// What differs here, and is pinned: this backend has no coverage surface,
// so a mono drawing is cached as argb32 with its colour in the key — one
// entry per colour, each drawn in that colour — and a blurred shadow, whose
// blur is a pass over the mask, stays live.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createRoot } from '../src/index.js';
import { paintCacheFor } from '../src/paintcache.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;

function fakeBridge() {
  const calls = [];
  let seq = 0;
  let backendCb = null;
  const native = {
    calls,
    of: (name) => calls.filter((c) => c[0] === name),
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 1,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2(options) {
      return { id: ++seq, options: { ...options } };
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    setBackendEventCallback(cb) {
      backendCb = cb;
    },
    emit: (ev) => backendCb?.(ev),
    createSurfaceIOSurface(width, height, scale) {
      const id = ++seq;
      return { handle: { id, width, height, scale }, iosurfaceId: id };
    },
    createSurface(width, height, scale) {
      const handle = { id: ++seq, width, height, scale };
      calls.push(['createSurface', handle.id, width, height]);
      return handle;
    },
    releaseSurface(handle) {
      calls.push(['releaseSurface', handle.id]);
    },
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
    ctxSetFillColor(handle, r, g, b, a) {
      calls.push(['ctxSetFillColor', handle.id, r, g, b, a]);
    },
    ctxDrawSurface(dst, src, ...rest) {
      calls.push(['ctxDrawSurface', dst.id, src.id, ...rest]);
    },
  };
  return new Proxy(native, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

async function mount(children) {
  const native = fakeBridge();
  const app = new CocoaApp(native);
  setScaleForTests(app, 1, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1440, height: 900 }],
    workArea: { x: 0, y: 0, width: 1440, height: 875 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  native.setBackendEventCallback((ev) => app._route(ev));
  const root = await createRoot({ app });
  roots.push(root);
  const render = (kids) =>
    root.render(h('window', { width: 200, height: 200 }, ...kids));
  render(children);
  await tick();
  const wnd = [...app._windows.values()][0];
  const node = wnd._reactX11Node;
  app._tickFrames();
  const frame = async (kids) => {
    if (kids) render(kids);
    await tick();
    app._tickFrames();
  };
  const repaint = async () => {
    node.invalidate(true, null, 'expose');
    app._tickFrames();
  };
  return { native, app, root, wnd, node, frame, repaint };
}

const SQUARE = (paint) =>
  `<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="${paint}"/></svg>`;

const TWO_COLOUR =
  '<svg viewBox="0 0 10 10">' +
  '<rect width="10" height="5" fill="#ff0000"/>' +
  '<rect y="5" width="10" height="5" fill="#0000ff"/></svg>';

/** `count` cells of one drawing in a row, in `color`. */
const wall = (source, count, color) =>
  Array.from({ length: count }, (_, i) =>
    h('svg', {
      key: i,
      source,
      style: {
        position: 'absolute',
        left: i * 20,
        top: 0,
        width: 16,
        height: 16,
        color,
      },
    }),
  );

test('a Cocoa app gets a cache: its surfaces are its own, not an X pixmap', async () => {
  const { app, node } = await mount(wall(TWO_COLOUR, 4));
  const cache = node._paintCache;
  assert.ok(cache, 'the window node has a cache');
  assert.equal(cache, paintCacheFor(app), 'one per app');
  assert.equal(cache.coverage, false, 'and no coverage surfaces');
  // the gate, without a whole app: a backend that makes surfaces qualifies
  assert.ok(paintCacheFor({ createSurface() {} }));
  assert.equal(paintCacheFor({ display: {} }), null);
});

test('identical drawings share one rendered copy, composited through the bridge', async () => {
  const { native, node, repaint } = await mount(wall(TWO_COLOUR, 4));
  const cache = node._paintCache;
  assert.equal(cache.entries.size, 1, 'four cells, one entry');
  assert.equal(cache.stats.renders, 1);
  const [entry] = cache.entries.values();
  assert.equal(entry.surface.format, 'argb32');
  const made = native.of('createSurface');
  assert.equal(made.length, 1, 'one CG bitmap, icon-sized');
  assert.deepEqual(made[0].slice(2), [16, 16]);
  // three cells composited from it on the first frame (the first cell was
  // the sighting that armed the gate), four on a repaint
  const blits = () =>
    native.of('ctxDrawSurface').filter((c) => c[2] === made[0][1]).length;
  assert.equal(blits(), 3);
  await repaint();
  assert.equal(cache.stats.renders, 1, 'nothing re-rendered');
  assert.equal(blits(), 7);
});

test('a mono drawing bakes its colour: one entry per colour, each drawn in it', async () => {
  const { native, node, frame, repaint } = await mount(
    wall(SQUARE('currentColor'), 4, '#ff0000'),
  );
  const cache = node._paintCache;
  assert.equal(cache.entries.size, 1);
  const [red] = cache.entries.keys();
  assert.match(red, /\|ink:#ff0000$/, 'the tint is in the key');
  const [entry] = cache.entries.values();
  assert.equal(entry.surface.format, 'argb32', 'no a8 here');
  // the drawing went into the entry's surface in red, not in coverage white
  const fills = native
    .of('ctxSetFillColor')
    .filter((c) => c[1] === entry.surface._surfaceHandle.id);
  assert.ok(fills.length, 'a fill was set on the entry surface');
  assert.deepEqual(fills.at(-1).slice(2), [1, 0, 0, 1]);

  // recoloured: a second entry, drawn in blue — never the red one tinted.
  // The first frame after the change paints live (a style change rebuilds
  // the document, and a rebuilt document opts out for that frame — see
  // SvgNode.paintCachePlan); the entry lands on the next.
  await frame(wall(SQUARE('currentColor'), 4, '#0000ff'));
  assert.equal(cache.entries.size, 1, 'the rebuilt document painted live');
  await repaint();
  assert.equal(cache.entries.size, 2, 'a new entry for the new colour');
  assert.equal(cache.stats.renders, 2);
  const blue = [...cache.entries.values()].at(-1);
  assert.notEqual(blue, entry);
  const blueFills = native
    .of('ctxSetFillColor')
    .filter((c) => c[1] === blue.surface._surfaceHandle.id);
  assert.deepEqual(blueFills.at(-1).slice(2), [0, 0, 1, 1]);
});

test('a blurred shadow stays live: coverage-only work has no argb32 form here', async () => {
  const { native, node, repaint } = await mount([
    h('box', {
      style: {
        position: 'absolute',
        left: 40,
        top: 40,
        width: 60,
        height: 40,
        backgroundColor: '#ffffff',
        boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
      },
    }),
    ...wall(TWO_COLOUR, 2),
  ]);
  const cache = node._paintCache;
  await repaint();
  await repaint();
  assert.equal(cache.entries.size, 1, 'the icons, and nothing for the shadow');
  assert.equal(cache.stats.failed, 0, 'and no render was even attempted');
  assert.equal(
    native.of('createSurface').length,
    1,
    'one surface: the icon entry',
  );
});

test('an evicted or unmounted entry hands its bitmap back to the bridge', async () => {
  const { native, node, root } = await mount(wall(TWO_COLOUR, 4));
  const cache = node._paintCache;
  const [entry] = cache.entries.values();
  const id = entry.surface._surfaceHandle.id;
  cache.destroy();
  assert.ok(
    native.of('releaseSurface').some((c) => c[1] === id),
    'released through the bridge, not left to the finalizer',
  );
  await root.unmount();
  roots.splice(0);
});
