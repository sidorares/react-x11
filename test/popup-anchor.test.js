// Anchoring to something smaller than a node, and to a popup whose size is
// its content's.
//
// The case both halves come from is a completion list: a `<popup>` that must
// open **at the caret** — a moving point inside one element — sized to the
// rows it happens to have. Neither half is expressible by measuring a node
// and passing a rect (issue #255): the caret is not the editor, and a popup
// whose width comes from its labels has no size at the moment React would
// have to compute a position from one.
//
// Headless, so there are no fonts and text measures 0x0 (see AGENTS.md): the
// rows here are sized boxes. The mock's monitor is 1280x800.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot } from '../src/index.js';
import { anchorRect, useAnchor, useAnchorTracking } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';
import { setScreensForTests } from '../src/screens.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Poll until `fn()` is truthy, or fail after `ms`. */
async function waitFor(fn, what, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function renderMock(app, element) {
  const x11Root = await createRoot({ app });
  await new Promise((resolve) => x11Root.render(element, resolve));
  await tick();
  await tick();
  return x11Root;
}

// --- the geometry ----------------------------------------------------------

/** A stand-in node: a laid-out rect, an owner window, and a monitor. */
function fakeNode(abs, { win = { x: 100, y: 50 }, monitor } = {}) {
  const app = {};
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1000, height: 800, ...monitor }],
  });
  return { abs, root: { window: win }, app };
}

test('`at` anchors to a rect inside the node, in the node’s coordinates', () => {
  const editor = fakeNode({ x: 10, y: 20, width: 400, height: 300 });
  // a caret 40 across and 3 lines down the editor's own content
  const caret = { x: 40, y: 48, width: 1, height: 16 };

  const at = anchorRect(editor, { at: caret, width: 200, height: 100 });
  assert.deepStrictEqual(
    [at.x, at.y],
    [100 + 10 + 40, 50 + 20 + 48 + 16 + 2],
    'the owner window, the node, then the caret — and the gap under it',
  );

  // and without it the whole node is the anchor, which is the popup opening
  // under the bottom of the editor instead of under the line being typed on
  const whole = anchorRect(editor, { width: 200, height: 100 });
  assert.deepStrictEqual([whole.x, whole.y], [100 + 10, 50 + 20 + 300 + 2]);
});

// The bug behind issue #453: on Cocoa the whole layout was seeded with the
// primary screen's `visibleFrame` as *the* work area, and `usable()` applies
// a desktop-wide work area as a per-axis bound on whichever monitor was
// picked. A second display wider than the built-in therefore kept its own
// `x` and inherited the primary's `width`, and every popup that reached past
// that short right edge was silently pulled back to it.
test('a popup on a wider second display is not clamped to the primary’s width', () => {
  const twoHeads = (workArea) => {
    const app = {};
    setScreensForTests(app, {
      monitors: [
        {
          x: 0,
          y: 0,
          width: 1440,
          height: 900,
          visible: { x: 0, y: 25, width: 1440, height: 875 },
        },
        {
          x: 1440,
          y: 0,
          width: 2560,
          height: 1440,
          visible: { x: 1440, y: 0, width: 2560, height: 1440 },
        },
      ],
      workArea,
    });
    return app;
  };
  // a trigger three quarters of the way across the external display
  const trigger = (app) => ({
    abs: { x: 100, y: 50, width: 200, height: 30 },
    root: { window: { x: 2900, y: 100 } },
    app,
  });

  const at = anchorRect(trigger(twoHeads(null)), { width: 300, height: 200 });
  assert.deepStrictEqual(
    [at.x, at.y],
    [3000, 100 + 50 + 30 + 2],
    'placed where it was asked, well inside the 1440..4000 head',
  );

  // and the primary's work area riding along as the desktop's — which is
  // what the Cocoa backend published — changes nothing, because each head
  // now carries its own usable rect
  const withPrimaryWorkArea = anchorRect(
    trigger(twoHeads({ x: 0, y: 25, width: 1440, height: 875 })),
    { width: 300, height: 200 },
  );
  assert.strictEqual(withPrimaryWorkArea.x, 3000);

  // the same layout with no per-monitor rects is the old behaviour, and is
  // what the assertion above is worth: 1440 as a width bound puts the
  // external head's right edge at 2880, and the popup back at 2580.
  const app = {};
  setScreensForTests(app, {
    monitors: [
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: 1440, y: 0, width: 2560, height: 1440 },
    ],
    workArea: { x: 0, y: 25, width: 1440, height: 875 },
  });
  assert.strictEqual(
    anchorRect(trigger(app), { width: 300, height: 200 }).x,
    2580,
  );
});

test('a sub-rect flips and clamps as if it were the node', () => {
  // an editor filling the screen, with the caret near the bottom of it: what
  // has to flip is the popup at *the caret*, and the editor's own bottom edge
  // is nowhere near — anchoring to the node cannot see this at all.
  const editor = fakeNode(
    { x: 0, y: 0, width: 1000, height: 780 },
    { win: { x: 0, y: 0 } },
  );
  const size = { width: 200, height: 120 };

  const mid = anchorRect(editor, {
    at: { x: 20, y: 600, width: 1, height: 16 },
    ...size,
  });
  assert.strictEqual(mid.placement, 'bottom', 'still room under the caret');
  assert.strictEqual(mid.y, 600 + 16 + 2);

  const low = anchorRect(editor, {
    at: { x: 20, y: 700, width: 1, height: 16 },
    ...size,
  });
  assert.strictEqual(low.placement, 'top', 'no room under the caret');
  assert.strictEqual(low.y, 700 - 120 - 2, 'sits above the caret');

  // and the right edge is met by the caret, not by the editor
  const wide = anchorRect(editor, {
    at: { x: 950, y: 10, width: 1, height: 16 },
    ...size,
  });
  assert.strictEqual(wide.x, 1000 - 200, 'pulled back onto the screen');
});

test('an `at` with no size is a point, and is what `width` then defaults to', () => {
  const node = fakeNode(
    { x: 0, y: 0, width: 400, height: 300 },
    {
      win: { x: 0, y: 0 },
    },
  );
  const point = anchorRect(node, { at: { x: 30, y: 40 }, height: 50 });
  assert.deepStrictEqual(
    [point.x, point.y, point.width],
    [30, 40 + 0 + 2, 0],
    'zero-sized: the gap is measured from the point itself',
  );
});

test('`align` reads the sub-rect too', () => {
  const node = fakeNode(
    { x: 0, y: 0, width: 400, height: 300 },
    {
      win: { x: 0, y: 0 },
    },
  );
  const cell = { x: 100, y: 20, width: 80, height: 24 };
  const centred = anchorRect(node, {
    at: cell,
    align: 'center',
    width: 40,
    height: 30,
  });
  assert.strictEqual(centred.x, 100 + (80 - 40) / 2, 'centred on the cell');
});

// --- tracking a caret ------------------------------------------------------

/**
 * The shape the completion popup takes at the widget layer: a rect measured
 * once on open and tracked after, with `at` naming the caret.
 */
function CaretPopup({ editorRef, caret, popupRef, onClose }) {
  const measure = useAnchor(editorRef);
  const [rect, setRect] = React.useState(null);
  const getOptions = () => ({ at: caret, width: 120, height: 60 });

  React.useLayoutEffect(() => {
    const next = measure(getOptions());
    if (next) setRect(next);
  }, [caret.x, caret.y]);

  useAnchorTracking(editorRef, true, getOptions, setRect, onClose);

  return (
    rect &&
    h('popup', {
      ref: popupRef,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    })
  );
}

test('tracking follows a caret that moves inside a still node', async () => {
  const app = createMockApp();
  const editorRef = React.createRef();
  const popupRef = React.createRef();

  const Scene = ({ caret }) =>
    h(
      'window',
      { width: 300, height: 200 },
      h('box', { ref: editorRef, style: { margin: 10, flexGrow: 1 } }),
      h(CaretPopup, { editorRef, caret, popupRef }),
    );

  const x11Root = await renderMock(
    app,
    h(Scene, { caret: { x: 20, y: 30, width: 1, height: 16 } }),
  );
  assert.deepStrictEqual(
    [popupRef.current.x, popupRef.current.y],
    [10 + 20, 10 + 30 + 16 + 2],
    'the caret inside the editor, not the editor',
  );

  // typing moves the caret; nothing about the node's layout changed
  await new Promise((resolve) =>
    x11Root.render(
      h(Scene, { caret: { x: 64, y: 46, width: 1, height: 16 } }),
      resolve,
    ),
  );
  await tick();
  assert.deepStrictEqual(
    [popupRef.current.x, popupRef.current.y],
    [10 + 64, 10 + 46 + 16 + 2],
    'the popup followed it',
  );

  await x11Root.unmount();
});

test('out of view is the caret’s, not the node’s', async () => {
  const app = createMockApp();
  const editorRef = React.createRef();
  const popupRef = React.createRef();
  const closed = { current: 0 };

  // a scrolling viewport with a tall document in it: the document node stays
  // firmly on screen while its own lines scroll away underneath
  const Scene = ({ caret }) =>
    h(
      'window',
      { width: 300, height: 200 },
      h(
        'box',
        { style: { overflow: 'scroll', height: 100 } },
        h('box', { ref: editorRef, style: { height: 600 } }),
      ),
      h(CaretPopup, {
        editorRef,
        caret,
        popupRef,
        onClose: () => closed.current++,
      }),
    );

  const caret = { x: 20, y: 30, width: 1, height: 16 };
  const x11Root = await renderMock(app, h(Scene, { caret }));
  const scroller = app.windows[0]._reactX11Node.children.find((n) =>
    n.isScroller?.(),
  );
  assert.ok(scroller, 'scroll box mounted');
  assert.strictEqual(closed.current, 0, 'the caret is in view to start with');

  // the document is 600 tall in a 100 viewport, so this leaves the *node*
  // very much on screen — and the caret's line 200px above the viewport
  scroller.scrollTo({ y: 260 });

  await waitFor(
    () => closed.current > 0,
    'the popup being told its caret had gone',
  );

  await x11Root.unmount();
});

// --- a popup that sizes itself ---------------------------------------------

/** The whole completion-popup pattern: anchored at a caret, sized by its
 *  rows, capped, with no measurement in the application at all. */
function Completions({ editorRef, caret, rows, popupRef, maxHeight = 200 }) {
  return h(
    'popup',
    {
      ref: popupRef,
      anchor: { to: editorRef, at: caret, placement: 'bottom' },
      grab: true,
      maxHeight,
    },
    h(
      'box',
      { style: { overflow: 'scroll', padding: 4 } },
      ...rows.map((label, i) =>
        h('box', { key: label, style: { width: 40 + i * 30, height: 20 } }),
      ),
    ),
  );
}

/** A scene whose popup only opens on the second render, which is what an
 *  application does: the trigger is laid out by the time it is anchored to. */
function completionScene(app, { editorStyle } = {}) {
  const editorRef = React.createRef();
  const popupRef = React.createRef();
  const Scene = ({ open, caret, rows = ['a'], maxHeight }) =>
    h(
      'window',
      { width: 400, height: 300 },
      h('box', {
        ref: editorRef,
        style: { margin: 20, flexGrow: 1, ...editorStyle },
      }),
      open && h(Completions, { editorRef, caret, rows, popupRef, maxHeight }),
    );
  return { editorRef, popupRef, Scene };
}

test('an anchored popup is born at its content’s size, in the right place', async () => {
  const app = createMockApp();
  const { Scene } = completionScene(app);
  const caret = { x: 30, y: 40, width: 1, height: 16 };

  const x11Root = await renderMock(app, h(Scene, { open: false, caret }));
  assert.strictEqual(app.windows.length, 1, 'no popup yet');

  await new Promise((resolve) =>
    x11Root.render(h(Scene, { open: true, caret, rows: ['a', 'b'] }), resolve),
  );
  await tick();

  const popup = app.windows[1];
  // 4 + max(40, 70) + 4 across, 4 + 20 + 20 + 4 down: the content's own size
  assert.deepStrictEqual([popup.width, popup.height], [78, 48]);
  // the editor is at (20, 20) in the window, the caret 30 across and 40 down
  // it, and the popup a 2px gap under the caret's line
  assert.deepStrictEqual(
    [popup.x, popup.y],
    [20 + 30, 20 + 40 + 16 + 2],
    'placed from the size it had just measured',
  );
  assert.deepStrictEqual(
    popup.calls.filter(([op]) => op === 'move'),
    [],
    'born there rather than moved there — nothing to see flash',
  );

  await x11Root.unmount();
});

test('growing content re-places an anchored popup', async () => {
  const app = createMockApp();
  const { popupRef, Scene } = completionScene(app);
  // a short screen, and a caret low on it: two rows fit under the caret and
  // six do not — which is a fact about the popup's own size, so nothing
  // outside the popup could have decided it.
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 1280, height: 300 }],
  });
  const caret = { x: 10, y: 200, width: 1, height: 16 };

  const x11Root = await renderMock(
    app,
    h(Scene, { open: true, caret, rows: ['a', 'b'] }),
  );
  assert.strictEqual(popupRef.current.height, 4 + 2 * 20 + 4);
  assert.strictEqual(popupRef.current.y, 20 + 200 + 16 + 2, 'below the caret');

  await new Promise((resolve) =>
    x11Root.render(
      h(Scene, { open: true, caret, rows: ['a', 'b', 'c', 'd', 'e', 'f'] }),
      resolve,
    ),
  );
  await waitFor(
    () => popupRef.current.height === 4 + 6 * 20 + 4,
    `the popup growing to its rows (got ${popupRef.current.height})`,
  );
  assert.strictEqual(
    popupRef.current.y,
    20 + 200 - (4 + 6 * 20 + 4) - 2,
    'and flipping above the caret, which only its own size could decide',
  );

  await x11Root.unmount();
});

test('maxHeight caps the content, and the rows scroll inside the cap', async () => {
  const app = createMockApp();
  const { popupRef, Scene } = completionScene(app);
  const caret = { x: 10, y: 20, width: 1, height: 16 };

  const x11Root = await renderMock(
    app,
    h(Scene, {
      open: true,
      caret,
      maxHeight: 60,
      rows: ['a', 'b', 'c', 'd', 'e', 'f'],
    }),
  );
  assert.strictEqual(popupRef.current.height, 60, 'capped');
  assert.strictEqual(popupRef.current.y, 20 + 20 + 16 + 2, 'and still below');
  // the width is still the content's: a cap on one axis is not a cap on the
  // other, and `overflow: 'scroll'` shrinking to a bound it was not given
  // would be a menu narrower than its own labels
  assert.strictEqual(popupRef.current.width, 4 + 190 + 4);

  const list = popupRef.current._reactX11Node.children[0];
  assert.ok(list.isScroller?.(), 'the rows are in a scrolling box');
  assert.ok(
    list.contentHeight > list.abs.height,
    `the overflow is the scroll (${list.contentHeight} in ${list.abs.height})`,
  );

  await x11Root.unmount();
});

test('an anchored popup follows the node it hangs off', async () => {
  const app = createMockApp();
  const editorRef = React.createRef();
  const popupRef = React.createRef();
  const caret = { x: 10, y: 10, width: 1, height: 16 };

  const Scene = ({ spacer }) =>
    h(
      'window',
      { width: 300, height: 300 },
      h('box', { style: { height: spacer } }),
      h('box', { ref: editorRef, style: { width: 200, height: 100 } }),
      h(Completions, { editorRef, caret, rows: ['a'], popupRef }),
    );

  const x11Root = await renderMock(app, h(Scene, { spacer: 0 }));
  const before = popupRef.current.y;

  await new Promise((resolve) =>
    x11Root.render(h(Scene, { spacer: 40 }), resolve),
  );
  await waitFor(
    () => popupRef.current.y === before + 40,
    `the popup following the editor down (got ${popupRef.current.y})`,
  );

  await x11Root.unmount();
});

test('an anchored popup unmaps while its anchor is out of view', async () => {
  const app = createMockApp();
  const editorRef = React.createRef();
  const popupRef = React.createRef();
  const caret = { x: 10, y: 30, width: 1, height: 16 };

  const Scene = () =>
    h(
      'window',
      { width: 300, height: 200 },
      h(
        'box',
        { style: { overflow: 'scroll', height: 100 } },
        h('box', { ref: editorRef, style: { height: 600 } }),
      ),
      h(Completions, { editorRef, caret, rows: ['a'], popupRef }),
    );

  const x11Root = await renderMock(app, h(Scene));
  const scroller = app.windows[0]._reactX11Node.children.find((n) =>
    n.isScroller?.(),
  );
  assert.strictEqual(popupRef.current.mapped, true, 'up to start with');

  scroller.scrollTo({ y: 260 });
  await waitFor(
    () => popupRef.current.mapped === false,
    'the popup going away with the line it points at',
  );
  assert.strictEqual(popupRef.current.grabbed, false, 'and letting go');

  scroller.scrollTo({ y: 0 });
  await waitFor(
    () => popupRef.current.mapped === true,
    'and coming back when it returns',
  );
  assert.strictEqual(
    popupRef.current.grabbed,
    true,
    're-grabbed: X drops a grab whose window stops being viewable',
  );
  assert.strictEqual(
    popupRef.current.y,
    30 + 16 + 2,
    'back where it belongs, not where it was',
  );

  await x11Root.unmount();
});

test('a popup whose anchor has not attached yet waits rather than flashing', async () => {
  const app = createMockApp();
  const editorRef = React.createRef();
  const popupRef = React.createRef();

  // the popup is written **above** its own trigger, so the ref is still
  // empty in the commit phase the popup realizes in
  const Scene = () =>
    h(
      'window',
      { width: 300, height: 200 },
      h(Completions, {
        editorRef,
        caret: { x: 10, y: 10, width: 1, height: 16 },
        rows: ['a'],
        popupRef,
      }),
      h('box', {
        ref: editorRef,
        style: { margin: 30, width: 100, height: 40 },
      }),
    );

  const app11Root = await createRoot({ app });
  await new Promise((resolve) => app11Root.render(h(Scene), resolve));
  const popup = app.windows[1];
  assert.strictEqual(
    popup.mapped,
    false,
    'not on screen while there is nothing to point at',
  );

  await tick();
  await tick();
  assert.strictEqual(popup.mapped, true, 'and up once the ref has attached');
  assert.deepStrictEqual(
    [popup.x, popup.y],
    [30 + 10, 30 + 10 + 16 + 2],
    'in the right place the first time it is seen',
  );

  await app11Root.unmount();
});

test('an anchored popup ignores x/y props', async () => {
  const app = createMockApp();
  const editorRef = React.createRef();
  const popupRef = React.createRef();

  const Scene = ({ x }) =>
    h(
      'window',
      { width: 300, height: 200 },
      h('box', {
        ref: editorRef,
        style: { margin: 10, width: 100, height: 40 },
      }),
      h(
        'popup',
        {
          ref: popupRef,
          x,
          y: 900,
          width: 50,
          height: 20,
          anchor: { to: editorRef },
        },
        h('box', { style: { flexGrow: 1 } }),
      ),
    );

  const x11Root = await renderMock(app, h(Scene, { x: 700 }));
  assert.deepStrictEqual(
    [popupRef.current.x, popupRef.current.y],
    [10, 10 + 40 + 2],
    'the anchor decides, not the props',
  );

  await new Promise((resolve) => x11Root.render(h(Scene, { x: 42 }), resolve));
  await tick();
  assert.strictEqual(popupRef.current.x, 10, 'and keeps deciding');

  await x11Root.unmount();
});
