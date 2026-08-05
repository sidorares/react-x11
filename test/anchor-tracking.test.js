// A popup anchored to a trigger used to be measured once, at the moment it
// opened, and never again: a scrolled ancestor, a trigger whose own layout
// moved it (a neighbouring field wrapping to a second line), or an owner
// window nudged by the window manager or a script all left it hanging over
// stale ground. `useAnchorTracking` (anchor.js) and the `onAnchorChange`
// subscription it reads (`WindowNode`, nodes.js) are the fix.
//
// These tests exercise the shared mechanism directly with a minimal tracked
// popup, rather than through any one widget — Select, Tooltip, MenuBar and
// rules.jsx's TokenField all sit on top of the same two functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { useAnchor, useAnchorTracking } from '../src/components/anchor.js';
import { createMockApp } from './helpers/mock-app.js';

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

/**
 * A trigger-anchored `<popup>` that stays live for as long as `open`: the
 * exact shape `Select`, `Tooltip` and `MenuBar` all follow — measure once on
 * open (so opening is instant, no extra frame of latency) and keep tracking
 * after (so it catches up whatever moves next). `onClose` is called instead
 * of tracking once the trigger scrolls entirely out of view.
 */
function TrackedPopup({
  open,
  onClose,
  triggerRef,
  popupRef,
  width = 60,
  height = 30,
}) {
  const measure = useAnchor(triggerRef);
  const [rect, setRect] = React.useState(null);
  const getOptions = () => ({ placement: 'bottom', width, height });

  React.useLayoutEffect(() => {
    if (!open) {
      setRect(null);
      return;
    }
    const next = measure(getOptions());
    if (next) setRect(next);
    // deliberately just `open`: `getOptions` is read fresh, not a dependency
  }, [open]);

  useAnchorTracking(triggerRef, open, getOptions, setRect, onClose);

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

async function renderMock(app, element) {
  const x11Root = await createRoot({ app });
  await new Promise((resolve) => x11Root.render(element, resolve));
  // layout runs on the frame after the commit
  await tick();
  await tick();
  return x11Root;
}

/**
 * `TrackedPopup` wrapped in its own `open` state, the way `Select` and the
 * others actually behave — `onClose` (an out-of-view notification, same as
 * Escape or a press outside) really shuts it, rather than a test only
 * observing that the callback fired.
 */
function Harness({ triggerRef, popupRef, closedRef }) {
  const [open, setOpen] = React.useState(true);
  const close = () => {
    if (closedRef) closedRef.current++;
    setOpen(false);
  };
  return h(TrackedPopup, { open, onClose: close, triggerRef, popupRef });
}

// Layout shared by both scroll tests: a couple of short rows, then the
// trigger (visible in the scrollview's own 100px viewport at scrollY 0),
// then enough rows after it that the view has 160px left to scroll through
// — some of that keeps the trigger visible and moved, the rest scrolls it
// entirely past the scrollview's own bottom edge.
function renderScrolledTrigger(app, popup) {
  const rowsBefore = Array.from({ length: 2 }, (_, i) =>
    h('box', { key: `before-${i}`, style: { height: 20 } }),
  );
  const rowsAfter = Array.from({ length: 10 }, (_, i) =>
    h('box', { key: `after-${i}`, style: { height: 20 } }),
  );
  return renderMock(
    app,
    h(
      'window',
      { width: 200, height: 150 },
      h(
        'scrollview',
        { style: { height: 100 } },
        ...rowsBefore,
        h('box', { ref: popup.triggerRef, style: { width: 80, height: 20 } }),
        ...rowsAfter,
      ),
      popup.element,
    ),
  );
}

test('a tracked popup follows a scrolled ancestor, while the trigger stays visible', async () => {
  const app = createMockApp();
  const triggerRef = React.createRef();
  const popupRef = React.createRef();
  const x11Root = await renderScrolledTrigger(app, {
    triggerRef,
    element: h(TrackedPopup, { open: true, triggerRef, popupRef }),
  });

  const wnd = app.windows[0];
  const windowNode = wnd._reactX11Node;
  const scroller = windowNode.children.find((n) => n.kind === 'scrollview');
  assert.ok(scroller, 'scrollview mounted');
  assert.ok(scroller.contentHeight > scroller.abs.height, 'content overflows');

  const before = { x: popupRef.current.x, y: popupRef.current.y };
  // the trigger sits at content y 40..60, so this leaves it at 10..30 —
  // still inside the scrollview's [0, 100) viewport
  scroller.scrollTo({ y: 30 });

  await waitFor(
    () => popupRef.current.y === before.y - 30,
    `the popup following the scroll (got ${popupRef.current.y}, want ${before.y - 30})`,
  );
  assert.strictEqual(popupRef.current.x, before.x, 'x unaffected by a vertical scroll');

  await x11Root.unmount();
});

test('a tracked popup closes once its trigger scrolls entirely out of view', async () => {
  const app = createMockApp();
  const triggerRef = React.createRef();
  const popupRef = React.createRef();
  const closedRef = { current: 0 };
  const x11Root = await renderScrolledTrigger(app, {
    triggerRef,
    element: h(Harness, { triggerRef, popupRef, closedRef }),
  });

  const wnd = app.windows[0];
  const scroller = wnd._reactX11Node.children.find(
    (n) => n.kind === 'scrollview',
  );
  assert.ok(popupRef.current, 'the popup opened');

  // the trigger sits at content y 40..60; scrolling past 60 puts it entirely
  // above the scrollview's own viewport, not merely moved within it
  scroller.scrollTo({ y: 90 });

  await waitFor(
    () => closedRef.current > 0,
    'onClose firing once the trigger left view',
  );
  await tick();
  assert.strictEqual(
    popupRef.current,
    null,
    'the popup unmounted rather than following the trigger off-view',
  );

  await x11Root.unmount();
});

test("a tracked popup follows the trigger's own layout moving under it", async () => {
  const app = createMockApp();
  const triggerRef = React.createRef();
  const popupRef = React.createRef();

  const Scene = ({ spacerHeight }) =>
    h(
      'window',
      { width: 200, height: 200 },
      // stands in for a neighbouring field wrapping to a second line: it
      // grows, and everything below it — the trigger included — moves down
      h('box', { style: { height: spacerHeight } }),
      h('box', { ref: triggerRef, style: { width: 80, height: 20 } }),
      h(TrackedPopup, { open: true, triggerRef, popupRef }),
    );

  const x11Root = await renderMock(app, h(Scene, { spacerHeight: 0 }));
  const before = { x: popupRef.current.x, y: popupRef.current.y };

  await new Promise((resolve) =>
    x11Root.render(h(Scene, { spacerHeight: 40 }), resolve),
  );

  await waitFor(
    () => popupRef.current.y === before.y + 40,
    `the popup following the trigger down (got ${popupRef.current.y}, want ${before.y + 40})`,
  );
  assert.strictEqual(popupRef.current.x, before.x, 'x unaffected by a vertical reflow');

  await x11Root.unmount();
});

// --- owner window moved by the WM or a script -------------------------------
// Needs a real (in-process) X connection: `_screenOrigin` only refreshes off
// a genuine TranslateCoordinates round trip, which the mock app has no
// server to answer (see anchor.js's screenOf/`_screenOrigin` comments).

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  const app = await createClient({ stream: clientEnd, fontSource });
  return { server, app };
}

function render(element, x11Root) {
  return new Promise((resolve) => {
    x11Root.render(element, resolve);
  });
}

async function settle(app, roundTrips = 3) {
  for (let i = 0; i < roundTrips; i++) {
    await new Promise((resolve, reject) =>
      app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
    );
  }
}

test('a tracked popup follows the owner window when it moves', async () => {
  const { app } = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const triggerRef = React.createRef();
    const popupRef = React.createRef();
    const wnd = await render(
      h(
        'window',
        { width: 200, height: 120, x: 0, y: 0 },
        h('box', {
          ref: triggerRef,
          style: { marginTop: 30, marginLeft: 20, width: 80, height: 20 },
        }),
        h(TrackedPopup, { open: true, triggerRef, popupRef }),
      ),
      x11Root,
    );
    await settle(app);

    const before = { x: popupRef.current.x, y: popupRef.current.y };
    assert.ok(before.x > 0 || before.y > 0, 'the popup measured somewhere real');

    app.X.ConfigureWindow(wnd.id, { x: 90, y: 55 });
    await waitFor(() => wnd.x === 90, 'the move ConfigureNotify');
    await waitFor(
      () =>
        popupRef.current.x === before.x + 90 &&
        popupRef.current.y === before.y + 55,
      `the popup following the window move ` +
        `(got ${popupRef.current.x},${popupRef.current.y}, ` +
        `want ${before.x + 90},${before.y + 55})`,
    );

    await x11Root.unmount();
    await settle(app);
  } finally {
    await app.close();
  }
});
