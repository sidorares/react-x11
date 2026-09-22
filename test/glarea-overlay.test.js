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

test("pointerEvents: 'box-none' on the surface: a child is the pointer's, and between the children, what is behind", async () => {
  // The shape an overlay of controls over a GL scene wants: the controls
  // take the pointer, and a press between them reaches whatever owns the
  // scene's input — here, the box the surface sits in — instead of the
  // surface, which has no handlers of its own to give it.
  const seen = [];
  const log = (who) => (ev) => seen.push({ who, target: ev.target });
  const s = await mount(
    () =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          'box',
          { style: { flexGrow: 1 }, onMouseDown: log('behind') },
          h(
            'glarea',
            {
              style: { flexGrow: 1, pointerEvents: 'box-none' },
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
      ),
    { panes: 1 },
  );
  try {
    const area = s.area();
    const [legend] = area.children;
    s.at(40, 25);
    s.server.injectButton(1, true);
    s.server.injectButton(1, false);
    await waitFor(() => seen.some((e) => e.who === 'legend'), 'the press');
    same(seen.find((e) => e.who === 'legend').target, legend, 'the child');

    seen.length = 0;
    s.at(150, 150);
    s.server.injectButton(1, true);
    s.server.injectButton(1, false);
    await waitFor(() => seen.length > 0, 'a press beside it');
    same(seen[0].target, area.parent, 'the box behind took it');
    assert.ok(
      !seen.some((e) => e.who === 'area'),
      'the surface was not the target, and nothing bubbled out of it',
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

// --- a child that only moved (issue #644) -----------------------------------
//
// A pane keeps what it holds between frames, so a child whose only change is
// where it sits is already painted, one shift away: the frame moves its
// pixels on the pane (`scrollRegion`, the verb the scroll blit uses on a
// window) and repaints only what that cannot supply. The proof obligation is
// the scroll blit's: the pane must hold the picture a pane that repaints
// would — so each of these renders the same tree twice, on two servers, the
// second with its panes' `scrollRegion` taken away (the overlay feature-
// detects it, as the scroll blit does the window's), and compares every
// pixel of the two after every step.

const TINTS = [
  '#e03131',
  '#2f9e44',
  '#1971c2',
  '#f08c00',
  '#9c36b5',
  '#0c8599',
  '#495057',
];

/**
 * The shape `<Flow>`'s mounted node bodies take over its GL graph: one box
 * bigger than the surface holding a grid of tiles, moved by `left`/`top`
 * alone on a pan, and a panel pinned over it (the minimap) that the pan must
 * not drag along. `tint` recolours one tile, `panel` the panel, `extra`
 * goes on the box of tiles, and `inside` is one more child of it.
 */
function panScene({
  left,
  top,
  tint = null,
  panel = '#ffffff',
  extra = {},
  inside = null,
}) {
  const tiles = [];
  for (let r = 0; r < 12; r++) {
    for (let c = 0; c < 16; c++) {
      const i = r * 16 + c;
      tiles.push(
        h('box', {
          key: i,
          style: {
            position: 'absolute',
            left: c * 50 + 3,
            top: r * 50 + 5,
            width: 40,
            height: 30,
            backgroundColor: i === 37 && tint ? tint : TINTS[i % TINTS.length],
          },
        }),
      );
    }
  }
  return h(
    'window',
    { width: 320, height: 240 },
    h(
      'glarea',
      { style: { flexGrow: 1 }, clearColor: '#102030', onDraw: () => {} },
      h(
        'box',
        {
          key: 'bodies',
          style: {
            position: 'absolute',
            left,
            top,
            width: 800,
            height: 600,
            ...extra,
          },
        },
        tiles,
        inside,
      ),
      h('box', {
        key: 'panel',
        style: {
          position: 'absolute',
          right: 10,
          bottom: 10,
          width: 80,
          height: 40,
          backgroundColor: panel,
        },
      }),
    ),
  );
}

const rectsOverlap = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

/** Every pixel of a pane, through the context the overlay paints with. */
function pixelsOf(pane) {
  const { width, height } = pane.rect;
  return new Promise((resolve, reject) =>
    pane
      .context()
      .getImageData(0, 0, width, height, (err, image) =>
        err ? reject(err) : resolve(Buffer.from(image.data)),
      ),
  );
}

/** The pixels two panes disagree on, as a count and the box around them. */
function paneDiff(a, b, width) {
  let count = 0;
  let box = null;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) {
      continue;
    }
    count += 1;
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    box = box
      ? {
          x0: Math.min(box.x0, x),
          y0: Math.min(box.y0, y),
          x1: Math.max(box.x1, x),
          y1: Math.max(box.y1, y),
        }
      : { x0: x, y0: y, x1: x, y1: y };
  }
  return { count, box };
}

/**
 * `build()` twice, on two servers: the first as it ships, the second with no
 * pane able to move pixels — the reference, which repaints. `step(element)`
 * renders an element into both and runs each frame at once, and `check`
 * compares their panes pixel for pixel. `blits` counts the first one's
 * pane moves and `painted` the pixels its passes cover, since the last
 * `step`.
 */
async function twins(build) {
  const a = await mount(build, { panes: 1 });
  const b = await mount(build, { panes: 1 });
  const overlayA = a.area()._overlay;
  const overlayB = b.area()._overlay;
  const [paneA] = overlayA.panes;
  const [paneB] = overlayB.panes;
  paneB.wnd.scrollRegion = undefined;
  const counts = { blits: 0, painted: 0 };
  const scrollRegion = paneA.wnd.scrollRegion.bind(paneA.wnd);
  paneA.wnd.scrollRegion = (...args) => {
    counts.blits += 1;
    return scrollRegion(...args);
  };
  const paintPane = overlayA._paintPane.bind(overlayA);
  overlayA._paintPane = (pane, passes) => {
    for (const pass of passes) counts.painted += pass.width * pass.height;
    return paintPane(pane, passes);
  };
  const frame = async (s, element) => {
    await new Promise((resolve) => s.root.render(element, resolve));
    s.windowNode.flush();
    await settle(s.app);
  };
  return {
    a,
    b,
    paneA,
    counts,
    async step(element) {
      counts.blits = 0;
      counts.painted = 0;
      await frame(a, element);
      await frame(b, element);
      // the same panes all along: a new one would be painted whole
      same(overlayA.panes[0], paneA, 'the pane');
      same(overlayB.panes[0], paneB, 'the reference’s pane');
    },
    async check(what) {
      const diff = paneDiff(
        await pixelsOf(paneA),
        await pixelsOf(paneB),
        paneA.rect.width,
      );
      assert.equal(
        diff.count,
        0,
        `${what}: ${diff.count} pixels differ from a repaint, in ` +
          JSON.stringify(diff.box),
      );
    },
    async close() {
      await a.close();
      await b.close();
    },
  };
}

test('a child that only moved is moved on its pane, and the frame repaints only what that uncovered', async () => {
  let left = -100;
  let top = -80;
  const t = await twins(() => panScene({ left, top }));
  try {
    await t.check('mounted');
    const area = t.paneA.rect.width * t.paneA.rect.height;
    // one axis, the other, both, back, and a step bigger than a tile
    for (const [dx, dy] of [
      [5, 0],
      [0, 7],
      [-13, 4],
      [21, -9],
      [-1, -1],
      [48, 0],
      [0, -30],
    ]) {
      left += dx;
      top += dy;
      await t.step(panScene({ left, top }));
      await t.check(`panned by (${dx}, ${dy})`);
      assert.equal(t.counts.blits, 1, `(${dx}, ${dy}): one move on the pane`);
      // the strips the move uncovered and the panel's two rects: a fraction
      // of the pane, where a repaint of the move was every pixel of it
      assert.ok(
        t.counts.painted < area / 4,
        `(${dx}, ${dy}): painted ${t.counts.painted} of ${area} pixels`,
      );
    }
  } finally {
    await t.close();
  }
});

test('what else a moving frame changes is repainted where it lands', async () => {
  let left = -100;
  let top = -80;
  const t = await twins(() => panScene({ left, top }));
  try {
    // a tile inside the moving child, recoloured in the same commit: claimed
    // where it was before layout ran, and the copy carried it on
    left += 17;
    top -= 6;
    await t.step(panScene({ left, top, tint: '#ffff00' }));
    await t.check('a tile recoloured as it moved');
    assert.equal(t.counts.blits, 1);
    // the panel over it, recoloured as the child under it moves: its own
    // claim, and the copy of its old pixels the move dragged along
    left -= 9;
    await t.step(panScene({ left, top, tint: '#ffff00', panel: '#00ffff' }));
    await t.check('the panel recoloured as the child under it moved');
    assert.equal(t.counts.blits, 1);
  } finally {
    await t.close();
  }
});

test('a child that moved and changed anything else is repainted, not moved', async () => {
  let left = -100;
  let top = -80;
  const t = await twins(() => panScene({ left, top }));
  try {
    // a background behind the tiles, in the same commit as the move: the
    // child drew differently, so its old pixels are not a shift away
    left += 11;
    await t.step(
      panScene({ left, top, extra: { backgroundColor: '#333333' } }),
    );
    await t.check('moved and given a background');
    assert.equal(t.counts.blits, 0, 'nothing moved on the pane');
    // …and a move that changes its size is not a move of its pixels either
    left += 7;
    await t.step(
      panScene({
        left,
        top,
        extra: { backgroundColor: '#333333', width: 790 },
      }),
    );
    await t.check('moved and resized');
    assert.equal(t.counts.blits, 0, 'nothing moved on the pane');
  } finally {
    await t.close();
  }
});

test('a scroll pane inside a moved child, laid out again as it moves, is repainted', async () => {
  // The one node that drops the layout diff under a shift: a scroll pane
  // whose content was laid out again claims its box and trusts that to cover
  // its rows. Riding a move its box claims nothing, so it claims itself —
  // without that, the rows a taller first row pushed down were carried by
  // the copy to where they were.
  const list = (first) =>
    h(
      'box',
      {
        key: 'list',
        scrollbarColor: 'transparent',
        style: {
          position: 'absolute',
          left: 160,
          top: 120,
          width: 90,
          height: 80,
          overflow: 'scroll',
          backgroundColor: '#000000',
        },
      },
      ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'].map((c, i) =>
        h('box', {
          key: i,
          style: {
            height: i === 0 ? first : 20,
            flexShrink: 0,
            backgroundColor: c,
          },
        }),
      ),
    );
  let left = -100;
  let top = -80;
  const t = await twins(() => panScene({ left, top, inside: list(20) }));
  try {
    left += 5;
    top += 3;
    await t.step(panScene({ left, top, inside: list(35) }));
    await t.check('the first row grew as the list moved');
  } finally {
    await t.close();
  }
});

test('children that move together move their pane, and are repainted', async () => {
  // On X11 a pane is as big as what it holds, so two children moving as one
  // take their pane with them — and what a pane holds is in its own corner,
  // not the window's: nothing in it is a shift away, and both are claimed.
  const pair = (left) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'glarea',
        { style: { flexGrow: 1 }, clearColor: '#102030', onDraw: () => {} },
        ['#ff0000', '#0000ff'].map((backgroundColor, i) =>
          h('box', {
            key: i,
            style: {
              position: 'absolute',
              left: left + i * 30,
              top: 40 + i * 20,
              width: 60,
              height: 40,
              backgroundColor,
            },
          }),
        ),
      ),
    );
  const t = await twins(() => pair(20));
  try {
    await t.step(pair(26));
    assert.equal(t.counts.blits, 0, 'nothing moved inside the pane');
    await t.check('moved together');
  } finally {
    await t.close();
  }
});

test('a child whose inset changed and who stayed put paints nothing', async () => {
  // `right` beside a `left` and a `width` is ignored: layout puts the child
  // where it was, and the change claims no pixels. The claim that asked for
  // the layout pass names no region, and a frame with none is not a
  // full-window repaint.
  const legend = (right) =>
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
            right,
            width: 60,
            height: 30,
            backgroundColor: '#ff0000',
          },
        }),
      ),
    );
  const s = await mount(() => legend(undefined), { panes: 1 });
  try {
    const overlay = s.area()._overlay;
    let passes = 0;
    const paintPane = overlay._paintPane.bind(overlay);
    overlay._paintPane = (pane, list) => {
      passes += list.length;
      return paintPane(pane, list);
    };
    await new Promise((resolve) => s.root.render(legend(5), resolve));
    s.windowNode.flush();
    await settle(s.app);
    assert.deepEqual(s.windowNode._lastDamageRects, [], 'the window: nothing');
    assert.equal(passes, 0, 'the pane: nothing');
  } finally {
    await s.close();
  }
});

test('a scroll inside a child of the surface moves the pane’s pixels, not the window’s', async () => {
  // The window paints none of a surface's children: a band of theirs is
  // only ever on a pane. Shifted in the window's backing store instead, the
  // scroll moved nothing on screen, and the strip it repainted left the pane
  // holding the old frame around it.
  let pane = null;
  const scroller = () =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'glarea',
        { style: { flexGrow: 1 }, clearColor: '#000000', onDraw: () => {} },
        h(
          'box',
          {
            ref: (n) => (pane = n ?? pane),
            scrollbarColor: 'transparent',
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              width: 300,
              height: 200,
              overflow: 'scroll',
            },
          },
          [
            '#ff0000',
            '#00ff00',
            '#0000ff',
            '#ffff00',
            '#ff00ff',
            '#00ffff',
          ].map((backgroundColor, i) =>
            h('box', {
              key: i,
              style: { height: 50, flexShrink: 0, backgroundColor },
            }),
          ),
        ),
      ),
    );
  const s = await mount(scroller, { panes: 1 });
  try {
    const [overlayPane] = s.area()._overlay.panes;
    const wnd = s.windowNode.window;
    let windowBlits = 0;
    const scrollRegion = wnd.scrollRegion.bind(wnd);
    wnd.scrollRegion = (...args) => {
      windowBlits += 1;
      return scrollRegion(...args);
    };
    let paneBlits = 0;
    const paneScroll = overlayPane.wnd.scrollRegion.bind(overlayPane.wnd);
    overlayPane.wnd.scrollRegion = (...args) => {
      paneBlits += 1;
      return paneScroll(...args);
    };
    pane.scrollTo(20);
    s.windowNode.flush();
    await settle(s.app);
    assert.equal(windowBlits, 0, 'the window’s pixels stayed put');
    assert.equal(paneBlits, 1, 'the pane’s moved');
    // the rows moved up by 20: the second one now starts at 30
    near(await rgbOf(overlayPane.wnd, 10, 10), RED, 'the first row, rising');
    near(await rgbOf(overlayPane.wnd, 10, 40), [0, 255, 0], 'the second row');
    near(await rgbOf(overlayPane.wnd, 10, 190), [255, 0, 255], 'the strip');
  } finally {
    await s.close();
  }
});

// --- whose damage is it -----------------------------------------------------
//
// The panes paint from a list of their own: the window's claims, less the
// ones that cannot reach a pane — and the window's list goes without the
// claims only a pane can show. A graph pane under the surface claims itself
// whole on every step of a pan (issue #644), and with one list between them
// the overlay repainted everything it holds on every step of it.

/** Count the passes an overlay's panes paint from now on. */
function countPasses(overlay) {
  const seen = { passes: 0 };
  const paintPane = overlay._paintPane.bind(overlay);
  overlay._paintPane = (pane, list) => {
    seen.passes += list.length;
    return paintPane(pane, list);
  };
  return seen;
}

/** A frame, run now: the commit, then the flush it scheduled. */
async function frameOf(s, element) {
  await new Promise((resolve) => s.root.render(element, resolve));
  s.windowNode.flush();
  await settle(s.app);
}

test('a change inside the overlay costs the window nothing', async () => {
  const s = await mount(() => legendAndPanel(), { panes: 2 });
  try {
    const seen = countPasses(s.area()._overlay);
    await frameOf(s, legendAndPanel({ legend: '#008000' }));
    assert.equal(seen.passes, 1, 'the legend’s pane repainted it');
    assert.deepEqual(
      s.windowNode._lastDamageRects,
      [],
      'and the window, which paints none of the surface’s children, nothing',
    );
    near(
      await rgbOf(s.area()._overlay.panes[0].wnd, 30, 15),
      GREEN,
      'recoloured',
    );
  } finally {
    await s.close();
  }
});

test('a node under the surface costs the panes nothing, and one above it reaches them', async () => {
  // The shape `<Flow renderer="gl">` has: a pane of its own under the
  // surface, laid over it and filling the same box, and a wrapper above
  // both whose colour the surface's children inherit. One `onDraw` for
  // every render: a new one is new content, and a claim of its own.
  const ink = (ctx) => ctx.fillRect(0, 0, 40, 20);
  const noDraw = () => {};
  const tree = ({ under = '#202020', color = '#ffffff' } = {}) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'box',
        { style: { flexGrow: 1, color } },
        h('box', {
          key: 'under',
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            backgroundColor: under,
          },
        }),
        h(
          'glarea',
          {
            key: 'gl',
            style: {
              position: 'absolute',
              left: 0,
              top: 0,
              right: 0,
              bottom: 0,
            },
            clearColor: '#102030',
            onDraw: noDraw,
          },
          // drawn in the ink it inherits, as a label would be
          h('canvas', {
            mono: true,
            style: {
              position: 'absolute',
              left: 10,
              top: 10,
              width: 40,
              height: 20,
            },
            onDraw: ink,
          }),
        ),
      ),
    );
  const s = await mount(() => tree(), { panes: 1 });
  try {
    const [pane] = s.area()._overlay.panes;
    near(await rgbOf(pane.wnd, 10, 10), [255, 255, 255], 'the ink, white');
    const seen = countPasses(s.area()._overlay);
    await frameOf(s, tree({ under: '#404040' }));
    assert.ok(
      s.windowNode._lastDamageRects === null ||
        s.windowNode._lastDamageRects.length > 0,
      'the window repainted the node under the surface',
    );
    assert.equal(seen.passes, 0, 'which no pane shows');
    await frameOf(s, tree({ under: '#404040', color: '#ffff00' }));
    near(
      await rgbOf(pane.wnd, 10, 10),
      [255, 255, 0],
      'the ink inherited from above the surface reached its pane',
    );
  } finally {
    await s.close();
  }
});

test('a surface child changing mid-scroll is no repair for the window’s blit', async () => {
  // A scroll pane holding a surface: the scroll blits the window, and what
  // changed inside the pane while it was armed is repaired after the blit
  // (issue #398) — but a surface's child is on a pane of its own, and the
  // window has nothing of it to repair.
  let list = null;
  // one ref and one `onDraw` for every render: a new function is a new
  // prop, and a claim of its own
  const listRef = (n) => (list = n ?? list);
  const noDraw = () => {};
  const tree = (legend) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'box',
        {
          ref: listRef,
          scrollbarColor: 'transparent',
          style: { flexGrow: 1, overflow: 'scroll' },
        },
        ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map((backgroundColor, i) =>
          h('box', {
            key: i,
            style: { height: 120, flexShrink: 0, backgroundColor },
          }),
        ),
        h(
          'glarea',
          {
            key: 'gl',
            style: {
              position: 'absolute',
              left: 180,
              top: 40,
              width: 120,
              height: 100,
            },
            clearColor: '#102030',
            onDraw: noDraw,
          },
          h('box', {
            style: {
              position: 'absolute',
              left: 10,
              top: 10,
              width: 40,
              height: 20,
              backgroundColor: legend,
            },
          }),
        ),
      ),
    );
  const s = await mount(() => tree('#ffffff'), { panes: 1 });
  try {
    const wnd = s.windowNode.window;
    let blits = 0;
    const scrollRegion = wnd.scrollRegion.bind(wnd);
    wnd.scrollRegion = (...args) => {
      blits += 1;
      return scrollRegion(...args);
    };
    // armed first, so the legend's claim arrives while the blit waits
    list.scrollTo(12);
    await new Promise((resolve) => s.root.render(tree('#ff00ff'), resolve));
    s.windowNode.flush();
    await settle(s.app);
    assert.equal(blits, 1, 'the window blitted the scroll');
    // the strip the scroll exposed and the bars, and nothing where the
    // legend went — its pane repainted it
    const legend = s.area().children[0].abs;
    for (const rect of s.windowNode._lastDamageRects) {
      assert.ok(
        !rectsOverlap(rect, legend),
        `the window repaired ${JSON.stringify(rect)} over the legend`,
      );
    }
    near(
      await rgbOf(s.area()._overlay.panes[0].wnd, 20, 15),
      [255, 0, 255],
      'the legend, recoloured on its pane',
    );
  } finally {
    await s.close();
  }
});

test('on X11 a pane’s ground follows the surface’s clearColor', async () => {
  // The surface's own claim is the panes' too: their ground is its colour.
  const noDraw = () => {};
  const tree = (clearColor) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'glarea',
        { style: { flexGrow: 1 }, clearColor, onDraw: noDraw },
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
    );
  const s = await mount(() => tree('#102030'), { panes: 1 });
  try {
    const [pane] = s.area()._overlay.panes;
    await frameOf(s, tree('#000000'));
    // 50% red over black
    near(await rgbOf(pane.wnd, 20, 20), [128, 0, 0], 'the new ground');
  } finally {
    await s.close();
  }
});

test('a child pushed along by another’s growth is repainted where it went', async () => {
  // Only the layout diff claims the one that was pushed: nothing about it
  // changed but where it sits, and it is no rigid move of a child of its
  // own — the two are in the flow of a box the surface holds. The box keeps
  // its size, so its pane does too and paints only what was claimed.
  const noDraw = () => {};
  const tree = (grow) =>
    h(
      'window',
      { width: 320, height: 240 },
      h(
        'glarea',
        { style: { flexGrow: 1 }, clearColor: '#000000', onDraw: noDraw },
        h(
          'box',
          {
            style: {
              position: 'absolute',
              left: 10,
              top: 10,
              width: 60,
              height: 100,
            },
          },
          h('box', {
            key: 'a',
            style: { height: grow, backgroundColor: '#ff0000' },
          }),
          h('box', {
            key: 'b',
            style: { height: 20, backgroundColor: '#0000ff' },
          }),
        ),
      ),
    );
  const s = await mount(() => tree(20), { panes: 1 });
  try {
    await frameOf(s, tree(40));
    const [pane] = s.area()._overlay.panes;
    const at = (x, y) => rgbOf(pane.wnd, x - pane.rect.x, y - pane.rect.y);
    near(await at(40, 45), RED, 'the grown one, where the other was');
    near(await at(40, 65), BLUE, 'the pushed one, where it went');
    near(await at(40, 75), [0, 0, 0], 'and the ground below it');
  } finally {
    await s.close();
  }
});

test('a sticky header in a scroll pane over the surface stays put on the pane', async () => {
  // The pane's own scroll blit carries the header along with the rows, and
  // the header's re-placement claims it back — both on the pane.
  let list = null;
  const listRef = (n) => (list = n ?? list);
  const noDraw = () => {};
  const s = await mount(
    () =>
      h(
        'window',
        { width: 320, height: 240 },
        h(
          'glarea',
          { style: { flexGrow: 1 }, clearColor: '#000000', onDraw: noDraw },
          h(
            'box',
            {
              ref: listRef,
              scrollbarColor: 'transparent',
              style: {
                position: 'absolute',
                left: 0,
                top: 0,
                width: 300,
                height: 200,
                overflow: 'scroll',
              },
            },
            h('box', {
              key: 'header',
              style: {
                position: 'sticky',
                top: 0,
                height: 20,
                flexShrink: 0,
                backgroundColor: '#ffffff',
              },
            }),
            ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff'].map(
              (backgroundColor, i) =>
                h('box', {
                  key: i,
                  style: { height: 50, flexShrink: 0, backgroundColor },
                }),
            ),
          ),
        ),
      ),
    { panes: 1 },
  );
  try {
    const [pane] = s.area()._overlay.panes;
    for (const y of [7, 19, 33]) {
      list.scrollTo(y);
      s.windowNode.flush();
      await settle(s.app);
      near(await rgbOf(pane.wnd, 10, 5), [255, 255, 255], `the header at ${y}`);
    }
    // rows under it moved up by 33: the first ends at 20 + 50 - 33 = 37
    near(await rgbOf(pane.wnd, 10, 30), RED, 'the first row, under it');
    near(await rgbOf(pane.wnd, 10, 45), [0, 255, 0], 'the second row');
  } finally {
    await s.close();
  }
});
