// A <glarea>'s children: 2D content drawn above the GL surface
// (src/gloverlay.js), on X11.
//
// Hermetic, like test/glarea.test.js: node-x11's in-process server with its
// GLX emulator registered, so the surface is a real GL child window and the
// panes are real child windows beside it. The in-process server keeps every
// window's pixels apart, so a pane's backing store is exactly what it shows,
// and the stacking the server reports is exactly what a real one would.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

import React from 'react';
import x11 from 'x11';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot, useSupports } from '../src/index.js';

const require = createRequire(import.meta.url);
const { createGlxExtension, RecordingBackend } = require('x11/browser/glx');

const h = React.createElement;

const POINTER_INPUT =
  x11.eventMask.ButtonPress |
  x11.eventMask.ButtonRelease |
  x11.eventMask.PointerMotion;

async function createGlApp({ indirectContexts = true } = {}) {
  const server = xserver.createServer({ width: 640, height: 480 });
  server.registerExtension(
    'GLX',
    createGlxExtension({
      backend: new RecordingBackend(),
      indirectContexts,
      getDrawableSurface: () => null,
    }),
  );
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({
    stream: clientEnd,
    fontSource: new StaticFontSource(),
    onXError: () => {},
  });
  return { app, server };
}

async function waitFor(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** `waitFor`, for a check that has to ask the server. */
async function eventually(check, what, timeout = 3000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settle = async (app, roundTrips = 3) => {
  for (let i = 0; i < roundTrips; i++) {
    await new Promise((resolve) => app.X.GetInputFocus(() => resolve()));
  }
};

/** The children of an X window, bottom to top — the server's stacking. */
const stacking = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.QueryTree(wid, (err, tree) =>
      err ? reject(err) : resolve(tree.children),
    ),
  );

/** `[r, g, b]` at a point of a window's backing store, window-local. */
function rgbOf(wnd, x, y) {
  const ctx = wnd.getContext('2d');
  return new Promise((resolve, reject) =>
    ctx.getImageData(x, y, 1, 1, (err, image) =>
      err ? reject(err) : resolve([...image.data.slice(0, 3)]),
    ),
  );
}

const near = (got, want, what, tolerance = 2) =>
  assert.ok(
    got.every((c, i) => Math.abs(c - want[i]) <= tolerance),
    `${what}: got rgb(${got}), want rgb(${want})`,
  );

/**
 * Nodes are compared by identity and named in the message, never handed to
 * `assert.equal`: a failed comparison `util.inspect`s both sides, a node
 * reaches the whole tree, the app and its connection, and the report then
 * takes minutes — a regression hangs the suite instead of failing it. Found
 * by planting one.
 */
const nameOf = (v) =>
  v == null
    ? String(v)
    : v.kind
      ? `<${v.kind}>`
      : v.id != null
        ? `window ${v.id}`
        : typeof v;
function same(actual, expected, what) {
  assert.ok(
    actual === expected,
    `${what}: got ${nameOf(actual)}, want ${nameOf(expected)}`,
  );
}

const whole = (r) => {
  const x = Math.floor(r.x);
  const y = Math.floor(r.y);
  return {
    x,
    y,
    width: Math.ceil(r.x + r.width) - x,
    height: Math.ceil(r.y + r.height) - y,
  };
};

/**
 * `build()` mounted in a 320x240 window and settled: the surface made (or
 * given up), its children laid out and their panes painted.
 */
async function mount(build, { indirectContexts = true, panes = null } = {}) {
  const { app, server } = await createGlApp({ indirectContexts });
  const root = await createRoot({ app });
  const close = async () => {
    await root.unmount();
    await app.close();
  };
  const render = (element) =>
    new Promise((resolve) => root.render(element, resolve));
  const instance = await render(build());
  const windowNode = instance._reactX11Node;
  const find = (n) =>
    n.kind === 'glarea' ? n : n.children.map(find).find(Boolean);
  const area = () => find(windowNode);
  try {
    await waitFor(
      () =>
        (area()?.window || area()?.error) &&
        (panes === null || (area()._overlay?.panes.length ?? 0) === panes),
      'the surface and its panes',
    );
    await settle(app);
  } catch (err) {
    // A mount that never settled still holds a connection, and a process
    // with one open never exits: a regression here would hang the suite
    // rather than fail it.
    await close();
    throw err;
  }
  return {
    app,
    server,
    root,
    windowNode,
    area,
    render: async (element) => {
      await render(element);
      await settle(app);
    },
    at(x, y) {
      const wnd = windowNode.window;
      const origin = wnd._screenOrigin ?? { x: wnd.x ?? 0, y: wnd.y ?? 0 };
      server.injectPointerMove(origin.x + x, origin.y + y);
    },
    async close() {
      await root.unmount();
      await app.close();
    },
  };
}

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];
const GREEN = [0, 128, 0];

/** A surface with a legend in one corner and a panel in the other. */
function legendAndPanel({ legend = '#ff0000', panel = true, ...extra } = {}) {
  return h(
    'window',
    { width: 320, height: 240 },
    h(
      'glarea',
      {
        style: { flexGrow: 1 },
        clearColor: '#102030',
        onDraw: () => {},
        ...extra,
      },
      h('box', {
        key: 'legend',
        style: {
          position: 'absolute',
          left: 10,
          top: 10,
          width: 60,
          height: 30,
          backgroundColor: legend,
        },
      }),
      panel &&
        h('box', {
          key: 'panel',
          style: {
            position: 'absolute',
            right: 10,
            bottom: 10,
            width: 80,
            height: 40,
            backgroundColor: '#0000ff',
          },
        }),
    ),
  );
}

test('the children of a <glarea> are drawn on panes stacked above the surface', async () => {
  const s = await mount(() => legendAndPanel(), { panes: 2 });
  try {
    const area = s.area();
    const [legend, panel] = area.children;
    // laid out in the surface's box, like a <box>'s
    assert.deepEqual(legend.abs, { x: 10, y: 10, width: 60, height: 30 });
    assert.deepEqual(panel.abs, { x: 230, y: 190, width: 80, height: 40 });
    // one pane per region the children reach, exactly where they are
    const panes = area._overlay.panes;
    assert.deepEqual(
      panes.map((p) => p.rect),
      [whole(legend.abs), whole(panel.abs)],
    );
    // above the surface: the server stacks the panes over the GL window,
    // which was made after them — its visual query answers after the first
    // frame — and restacked them over itself
    const ids = await stacking(s.app, s.windowNode.window.id);
    const gl = ids.indexOf(area.window.id);
    assert.ok(gl !== -1, 'the GL window is a child of the owning window');
    for (const pane of panes) {
      assert.ok(ids.indexOf(pane.wnd.id) > gl, 'a pane is above the surface');
    }
    // painted: each pane holds its child
    near(await rgbOf(panes[0].wnd, 30, 15), RED, 'the legend');
    near(await rgbOf(panes[1].wnd, 40, 20), BLUE, 'the panel');
    // …and the window's own backing does not: the children are the panes'
    const under = await rgbOf(s.windowNode.window, 40, 25);
    assert.notDeepEqual(under, RED, 'not painted into the window as well');
    // no pane takes the pointer: it reaches the tree by propagation
    for (const pane of panes) {
      assert.equal(pane.wnd.eventMask & POINTER_INPUT, 0);
    }
  } finally {
    await s.close();
  }
});

test('a change inside the overlay repaints its own pane, and no other', async () => {
  const s = await mount(() => legendAndPanel(), { panes: 2 });
  try {
    const [legendPane, panelPane] = s.area()._overlay.panes;
    // the pane whose child did not change must not be drawn into at all
    const panelCtx = panelPane.context();
    let panelFills = 0;
    const fillRect = panelCtx.fillRect;
    panelCtx.fillRect = function (...args) {
      panelFills += 1;
      return fillRect.apply(this, args);
    };
    await s.render(legendAndPanel({ legend: '#008000' }));
    const green = async () =>
      (await rgbOf(legendPane.wnd, 30, 15)).every(
        (c, i) => Math.abs(c - GREEN[i]) <= 2,
      );
    await eventually(green, 'the legend, recoloured');
    near(await rgbOf(panelPane.wnd, 40, 20), BLUE, 'the panel, untouched');
    assert.equal(panelFills, 0, 'the claim reached only the legend’s pane');
  } finally {
    await s.close();
  }
});

test('panes follow the layout, and go with the children they held', async () => {
  // the same shape of tree throughout, so React keeps every node and only
  // the layout and the child list move under the overlay
  const tree = (paddingTop, options) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'box',
        { style: { flexGrow: 1, paddingTop } },
        legendAndPanel(options).props.children,
      ),
    );
  const s = await mount(() => tree(0), { panes: 2 });
  try {
    const area = s.area();
    const before = await stacking(s.app, s.windowNode.window.id);
    // the surface moves: its children, and their panes, with it
    await s.render(tree(50));
    await waitFor(
      () => area._overlay?.panes[0]?.rect.y === 60,
      'the legend’s pane moved down',
    );
    assert.deepEqual(
      area._overlay.panes.map((p) => p.rect),
      area.children.map((c) => whole(c.abs)),
    );
    // a pane that only moved keeps what it holds: nothing to repaint
    near(await rgbOf(area._overlay.panes[0].wnd, 30, 15), RED, 'moved');
    // a child that goes takes its pane with it — the window too
    await s.render(tree(50, { panel: false }));
    await waitFor(() => area._overlay?.panes.length === 1, 'one pane');
    const after = await stacking(s.app, s.windowNode.window.id);
    assert.equal(after.length, before.length - 1, 'the pane window is gone');
    // …and the last one takes the overlay: nothing left over the surface
    await s.render(
      h(
        'window',
        { width: 320, height: 240 },
        h(
          'box',
          { style: { flexGrow: 1, paddingTop: 50 } },
          h('glarea', { style: { flexGrow: 1 }, onDraw: () => {} }),
        ),
      ),
    );
    await waitFor(() => !area._overlay, 'no overlay');
    const bare = await stacking(s.app, s.windowNode.window.id);
    assert.deepEqual(bare, [area.window.id], 'only the GL window left');
    assert.equal(s.windowNode._overlaid.size, 0);
  } finally {
    await s.close();
  }
});

test('children that overlap share a pane, painted in their order', async () => {
  const box = (key, left, top, backgroundColor) =>
    h('box', {
      key,
      style: {
        position: 'absolute',
        left,
        top,
        width: 60,
        height: 40,
        backgroundColor,
      },
    });
  const s = await mount(
    () =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          'glarea',
          { style: { flexGrow: 1 }, onDraw: () => {} },
          box('under', 20, 20, '#ff0000'),
          box('over', 50, 40, '#0000ff'),
        ),
      ),
    { panes: 1 },
  );
  try {
    const [pane] = s.area()._overlay.panes;
    assert.deepEqual(pane.rect, { x: 20, y: 20, width: 90, height: 60 });
    near(await rgbOf(pane.wnd, 5, 5), RED, 'the one underneath, alone');
    near(await rgbOf(pane.wnd, 45, 30), BLUE, 'the overlap: the later one');
  } finally {
    await s.close();
  }
});

test('on X11 a pane is opaque: what a child leaves unpainted is the surface’s clearColor', async () => {
  // A translucent fill blends with the pane's ground, which is what the GL
  // frame under it starts from — not with the frame itself. That is the
  // documented X11 limit (docs/elements.md); Cocoa composites for real.
  const s = await mount(
    () =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          'glarea',
          { style: { flexGrow: 1 }, clearColor: '#102030', onDraw: () => {} },
          h('box', {
            style: {
              position: 'absolute',
              left: 10,
              top: 10,
              width: 40,
              height: 40,
              backgroundColor: 'rgba(255, 0, 0, 0.5)',
            },
          }),
        ),
      ),
    { panes: 1 },
  );
  try {
    const [pane] = s.area()._overlay.panes;
    // 50% red over rgb(16, 32, 48)
    near(
      await rgbOf(pane.wnd, 20, 20),
      [136, 16, 24],
      'blended with the ground',
    );
  } finally {
    await s.close();
  }
});

test('the pointer over a child is the child’s; between the children, the surface’s', async () => {
  const seen = [];
  const log = (who) => (ev) => seen.push({ who, target: ev.target });
  const s = await mount(
    () =>
      h(
        'window',
        { width: 320, height: 240, onMouseOut: log('window') },
        h(
          'glarea',
          {
            style: { flexGrow: 1 },
            onDraw: () => {},
            onMouseDown: log('area'),
          },
          h('box', {
            style: {
              position: 'absolute',
              left: 10,
              top: 10,
              width: 60,
              height: 30,
              backgroundColor: '#ff0000',
            },
            onMouseDown: log('legend'),
          }),
        ),
      ),
    { panes: 1 },
  );
  try {
    const area = s.area();
    const [legend] = area.children;
    s.at(150, 150); // the surface
    s.at(40, 25); // onto the legend's pane: a crossing into a child window
    s.server.injectButton(1, true);
    s.server.injectButton(1, false);
    await waitFor(() => seen.some((e) => e.who === 'legend'), 'the press');
    same(seen.find((e) => e.who === 'legend').target, legend, 'the press');
    // it bubbled out through the surface, as out of any box
    same(seen.find((e) => e.who === 'area')?.target, legend, 'bubbled');
    seen.length = 0;
    s.at(150, 150);
    s.server.injectButton(1, true);
    s.server.injectButton(1, false);
    await waitFor(
      () => seen.some((e) => e.who === 'area'),
      'a press beside it',
    );
    same(seen.find((e) => e.who === 'area').target, area, 'a press beside');
    assert.ok(!seen.some((e) => e.who === 'legend'));
    assert.ok(
      !seen.some((e) => e.who === 'window'),
      'crossing onto a pane is not leaving the window',
    );
  } finally {
    await s.close();
  }
});

test('the children are drawn where GL is not, and are still the pointer’s', async () => {
  const seen = [];
  const s = await mount(
    () =>
      legendAndPanel({
        onError: () => {},
        onMouseDown: (ev) => seen.push(ev.target),
      }),
    { indirectContexts: false, panes: 2 },
  );
  try {
    const area = s.area();
    assert.ok(area.error, 'no GL surface on this server');
    assert.ok(!area.window, 'no GL window');
    const [legendPane] = area._overlay.panes;
    near(await rgbOf(legendPane.wnd, 30, 15), RED, 'the legend, drawn');
    // over a child: the child; between them, nothing covers the rect, and
    // the tree behind answers
    same(area.hitSurface(40, 25), area.children[0], 'over the legend');
    same(area.hitSurface(150, 150), null, 'between the children');
  } finally {
    await s.close();
  }
});

test('a hidden surface drops its panes, and a revealed one paints new ones', async () => {
  const tree = (display) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'box',
        { style: { flexGrow: 1, display } },
        legendAndPanel().props.children,
      ),
    );
  const s = await mount(() => tree('flex'), { panes: 2 });
  try {
    const area = s.area();
    await s.render(tree('none'));
    await waitFor(() => area._overlay?.panes.length === 0, 'no panes');
    await s.render(tree('flex'));
    await waitFor(() => area._overlay?.panes.length === 2, 'panes again');
    await settle(s.app);
    near(await rgbOf(area._overlay.panes[0].wnd, 30, 15), RED, 'repainted');
  } finally {
    await s.close();
  }
});

test("useSupports('glOverlay') is true on X11", async () => {
  let answer = null;
  function Probe() {
    answer = useSupports('glOverlay');
    return null;
  }
  const s = await mount(() =>
    h(
      'window',
      { width: 320, height: 240 },
      h('glarea', { style: { flexGrow: 1 }, onDraw: () => {} }),
      h(Probe),
    ),
  );
  try {
    assert.equal(answer, true);
  } finally {
    await s.close();
  }
});
