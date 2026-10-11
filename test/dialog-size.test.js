// How big a `<Dialog>` is, and where it opens (issue #940).
//
// A dialog used to be 360x170 whatever it held, and content taller than that
// was laid out past the bottom of the window and cut off there — the
// `actions` row with it, so the one row a dialog cannot do without was the
// first thing to go. Four apps built on the library hit it in one day.
//
// Its height is now its content's (`'auto'`, the default): the popup is
// measured, centred over its owner at that size and only then created, so
// it is born in the right place rather than moved there. Capped at the
// monitor it opens on, with the body scrolling inside the cap and the
// actions row pinned under it. A `height` number is still exactly that.
//
// Against the in-process X server, with a real font, because the thing
// that overflowed was text: ten lines of it. The geometry of the centring
// is pinned over the mock app, whose calls are recorded, and the Cocoa half
// over the fake bridge, where the window is on the point grid.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import {
  renderX11,
  cleanup,
  act,
  windowNodesOf,
} from '../src/testing/index.js';
import { Button, Dialog, createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { setScreensForTests } from '../src/screens.js';
import { fakeCocoaApp, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;
const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
const fonts = { 'sans-serif': FONT };

afterEach(cleanup);

const lines = (n) =>
  Array.from({ length: n }, (_, i) =>
    h('text', { key: i }, `Line ${i + 1} of the body`),
  );

/** The `<popup>` the `Dialog` opened. */
function popupOf(api) {
  const popup = windowNodesOf(api.windowNode).find((w) => w.isPopup);
  assert.ok(popup, 'the dialog opened a <popup>');
  return popup;
}

/** The node carrying `data-testname`, anywhere under `node`. */
function byTestName(node, name) {
  if (node.props?.['data-testname'] === name) return node;
  for (const child of node.children ?? []) {
    const found = byTestName(child, name);
    if (found) return found;
  }
  return null;
}

/** The dialog's own surface — `role="dialog"` — and its body (the scroller)
 *  and actions rows, its last two children (after the unmanaged title). */
function partsOf(popup) {
  const surface = popup.children[0];
  assert.equal(surface.props.role, 'dialog');
  const rows = surface.children;
  return {
    surface,
    body: rows[rows.length - 2],
    actions: rows[rows.length - 1],
  };
}

/** Whether `node` lies wholly inside its window, top to bottom. */
function inside(node) {
  const win = node.root.window;
  return node.abs.y >= 0 && node.abs.y + node.abs.height <= win.height;
}

function OwnerWithDialog({ managed, count, height }) {
  return h(
    'box',
    { style: { flexGrow: 1 } },
    h(
      Dialog,
      {
        open: true,
        title: 'Tall',
        managed,
        height,
        actions: h(Button, { label: 'OK', 'data-testname': 'ok' }),
      },
      lines(count),
    ),
  );
}

for (const managed of [true, false]) {
  describe(`managed={${managed}}`, () => {
    test('with no height, the dialog is as tall as its content, actions included', async () => {
      const api = await renderX11(h(OwnerWithDialog, { managed, count: 10 }), {
        fonts,
        width: 640,
        height: 480,
      });
      await act();
      const popup = popupOf(api);
      const { surface, actions } = partsOf(popup);
      const win = popup.window;
      assert.ok(
        win.height > 170,
        `ten lines and a button row are taller than 170 (got ${win.height})`,
      );
      assert.ok(
        win.height >= surface.abs.height,
        `the window (${win.height}) holds the surface (${surface.abs.height})`,
      );
      assert.ok(
        inside(actions),
        `the actions row (${actions.abs.y}..${actions.abs.y + actions.abs.height}) is inside the ${win.height}px window`,
      );
      const ok = byTestName(popup, 'ok');
      assert.ok(ok && inside(ok), 'and so is its button');
      assert.equal(win.width, 360, 'the width is still the default');
    });

    test('an explicit height is that height, as before', async () => {
      const api = await renderX11(
        h(OwnerWithDialog, { managed, count: 2, height: 170 }),
        { fonts, width: 640, height: 480 },
      );
      await act();
      const win = popupOf(api).window;
      assert.deepEqual([win.width, win.height], [360, 170]);
    });

    test('content taller than the screen: capped, the body scrolls, the actions stay', async () => {
      const api = await renderX11(h(OwnerWithDialog, { managed, count: 60 }), {
        fonts,
        width: 640,
        height: 300,
        screen: { width: 1024, height: 400 },
      });
      await act();
      const popup = popupOf(api);
      const { body, actions } = partsOf(popup);
      const win = popup.window;
      assert.ok(win.height <= 400, `capped at the screen (got ${win.height})`);
      assert.ok(
        win.y >= 0 && win.y + win.height <= 400,
        `and on it (${win.y}..${win.y + win.height})`,
      );
      assert.ok(body.isScroller?.(), 'the body is a scroller');
      assert.ok(
        body.contentHeight > body.abs.height,
        `that has something to scroll (${body.contentHeight} in ${body.abs.height})`,
      );
      assert.ok(inside(actions), 'the actions row is inside the window');
      assert.ok(actions.abs.height > 0, 'and was not squashed to nothing');
    });

    test('content that grows while open grows the dialog, from its top edge', async () => {
      const Grows = ({ count }) => h(OwnerWithDialog, { managed, count });
      const api = await renderX11(h(Grows, { count: 3 }), {
        fonts,
        width: 640,
        height: 480,
      });
      await act();
      const popup = popupOf(api);
      const before = { y: popup.window.y, height: popup.window.height };
      await api.rerender(h(Grows, { count: 12 }));
      await act();
      const win = popup.window;
      const { surface, actions } = partsOf(popup);
      assert.ok(
        win.height > before.height,
        `grew (${before.height} → ${win.height})`,
      );
      assert.ok(win.height >= surface.abs.height, 'to hold its content');
      assert.ok(inside(actions), 'with the actions row inside');
      assert.equal(win.y, before.y, 'and kept its top edge where it opened');
    });
  });
}

// A dialog laid out to fill its height — a field over a list that scrolls on
// its own, the chat example's join dialog — still fills it: the body that
// now scrolls must not turn into the thing that scrolls, with the list laid
// out whole inside it.
test('content that fills a fixed height still fills it, and its own list scrolls', async () => {
  const rows = Array.from({ length: 40 }, (_, i) =>
    h('box', { key: i, style: { height: 20 } }),
  );
  const api = await renderX11(
    h(
      'box',
      { style: { flexGrow: 1 } },
      h(
        Dialog,
        {
          open: true,
          height: 330,
          actions: h(Button, { label: 'Join' }),
        },
        h(
          'box',
          { style: { gap: 8, flexGrow: 1 } },
          h('box', { style: { height: 28 } }),
          h(
            'box',
            {
              'data-testname': 'list',
              style: { flexGrow: 1, overflow: 'scroll' },
            },
            rows,
          ),
        ),
      ),
    ),
    { fonts, width: 640, height: 480 },
  );
  await act();
  const popup = popupOf(api);
  const { body, actions } = partsOf(popup);
  const list = byTestName(popup, 'list');
  assert.equal(popup.window.height, 330);
  assert.ok(
    body.contentHeight <= body.abs.height,
    `the body has nothing to scroll (${body.contentHeight} in ${body.abs.height})`,
  );
  assert.ok(
    list.contentHeight > list.abs.height && inside(list),
    `the list scrolls, inside the window (${list.contentHeight} in ${list.abs.height})`,
  );
  assert.ok(inside(actions));
});

// --- placement, over the mock ------------------------------------------

/** A dialog of sized rows — the mock has no fonts — in a 600x400 window. */
function mockScene({ rows, managed = false, height }) {
  return h(
    'window',
    { width: 600, height: 400 },
    h(
      Dialog,
      {
        open: true,
        managed,
        height,
        actions: h('box', { style: { width: 80, height: 30 } }),
      },
      Array.from({ length: rows }, (_, i) =>
        h('box', { key: i, style: { height: 20 } }),
      ),
    ),
  );
}

async function renderMock(app, element) {
  const root = await createRoot({ app });
  await new Promise((resolve) => root.render(element, resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return root;
}

test('the dialog is centred over its owner at its natural size, and born there', async () => {
  const app = createMockApp();
  const root = await renderMock(app, mockScene({ rows: 4 }));
  const popup = app.windows.find((w) => w._reactX11Node?.isPopup);
  assert.ok(popup, 'opened');
  // 16 padding, 4 rows of 20 with 8 between, 12, a 30 row, 16 padding and
  // the 1px border at each end
  const height = 1 + 16 + (4 * 20 + 3 * 8) + 12 + 30 + 16 + 1;
  assert.deepEqual([popup.width, popup.height], [360, height]);
  assert.deepEqual(
    [popup.x, popup.y],
    [(600 - 360) / 2, Math.round((400 - height) / 2)],
    'centred over the owner from the size it had just measured',
  );
  assert.deepEqual(
    popup.calls.filter(([op]) => op === 'move' || op === 'setState'),
    [],
    'created there, rather than moved there',
  );
  await root.unmount();
});

test('growing past the bottom of the screen pulls an unmanaged dialog back up', async () => {
  const app = createMockApp();
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1280, height: 400 }],
  });
  const root = await renderMock(app, mockScene({ rows: 2 }));
  const popup = app.windows.find((w) => w._reactX11Node?.isPopup);
  const node = popup._reactX11Node;
  const openedAt = popup.y;
  await new Promise((resolve) => root.render(mockScene({ rows: 12 }), resolve));
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(popup.height > 300, `grew (got ${popup.height})`);
  assert.ok(popup.y < openedAt, 'moved up, since it no longer fit below');
  assert.equal(popup.y + popup.height, 400, 'just far enough to fit');
  assert.ok(node);
  await root.unmount();
});

test('a managed dialog the user moved grows where they put it', async () => {
  const app = createMockApp();
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1280, height: 400 }],
  });
  const root = await renderMock(app, mockScene({ rows: 2, managed: true }));
  const popup = app.windows.find((w) => w._reactX11Node?.isPopup);
  // the window manager moved it — a drag — and the server says so
  popup.x = 700;
  popup.y = 20;
  popup._screenOrigin = { x: 700, y: 20 };
  const grow = async (rows) => {
    await new Promise((resolve) =>
      root.render(mockScene({ rows, managed: true }), resolve),
    );
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const moves = () => popup.calls.filter(([op]) => op === 'move');

  await grow(5);
  assert.ok(popup.height > 150, `grew (got ${popup.height})`);
  assert.deepEqual(moves(), [], 'and nothing sent it back to the middle');

  // …until it would leave the monitor, and then only as far as it takes
  await grow(14);
  assert.deepEqual(moves(), [['move', 700, 400 - popup.height]]);
  await root.unmount();
});

// --- Cocoa ------------------------------------------------------------------

test('on Cocoa the dialog sizes to its content on the point grid, centred', async (t) => {
  const { app } = fakeCocoaApp();
  const root = await createRoot({ app });
  t.after(() => root.unmount());
  root.render(mockScene({ rows: 10, managed: true }));
  await tick();
  app._tickFrames();
  await tick();
  app._tickFrames();
  const windows = [...app._windows.values()];
  const popup = windows.find((w) => w._reactX11Node?.isPopup);
  const owner = windows.find((w) => !w._reactX11Node?.isPopup);
  assert.ok(popup, 'opened');
  const node = popup._reactX11Node;
  const s = node.scale;
  // the same content as above in logical pixels, at the bridge's scale
  const logical = 1 + 16 + (10 * 20 + 9 * 8) + 12 + 30 + 16 + 1;
  assert.equal(popup.height, Math.ceil(logical) * s);
  assert.equal(popup.width, 360 * s);
  const { actions } = partsOf(node);
  assert.ok(inside(actions), 'the actions row is inside the window');
  assert.equal(
    popup.x,
    owner.x + (owner.width - popup.width) / 2,
    'centred across the owner',
  );
});
