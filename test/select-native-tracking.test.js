// A native `<Select>`'s menu closed on the first unrelated layout pass
// whenever its trigger sat near the top of its window and the chosen option
// was not the first one (issue #552).
//
// A native popup button opens its menu *over* the control, the chosen row
// on the title — so with the third option chosen the menu starts two rows
// above the trigger. Select asked for that placement with an `at` sub-rect,
// and `useAnchorTracking` asks whether `at` is still in view before it
// re-measures: the check that closes a completion popup once its caret
// scrolls away. Near a window's top edge the rect two rows up is above that
// edge, so the first layout pass after opening — a status line ticking in
// the same toolbar, in the example that hit it — found it "scrolled out" and
// closed the menu. Opening runs no such check, which is why it opened first.
//
// The placement is an `offset` past the trigger now, so the view test is
// about the trigger itself. What is pinned: the menu survives a re-render
// with any option chosen, still puts the chosen row over the trigger, still
// follows a scroll that leaves the trigger visible, and still closes once
// the trigger really has scrolled away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { Select, createRoot } from '../src/index.js';
import { screenRect } from '../src/anchor.js';
import { createMockApp, pressButton } from '../src/testing/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** layout, the anchor notification, React's re-render and an unmount */
const settle = async () => {
  await tick();
  await tick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await tick();
};

/** Poll until `fn()` is truthy, or fail after `ms`. */
async function waitFor(fn, what, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** AppKit's metrics as a store on a mock app, as native-control-footprint
 *  stubs them: enough for Select to take the native-popup path. */
function bezelledApp() {
  const app = createMockApp();
  app.nativeBezels = {
    natural: () => ({ width: 60, height: 22 }),
    shadow: () => ({ top: 1, bottom: 2 }),
    get: () => ({ surface: {}, sx: 0, sy: 0, sw: 1, sh: 1 }),
  };
  return app;
}

const OPTIONS = ['a', 'b', 'c', 'd'];

/** every node under `tree`, in tree order, the popup windows excluded */
function nodes(tree) {
  const out = [];
  const walk = (n) => {
    out.push(n);
    for (const c of n.children) if (!c.isWindow) walk(c);
  };
  walk(tree);
  return out;
}

const menuOf = (trigger) => trigger.children.find((c) => c.isWindow) ?? null;

async function mount(element, size = { width: 400, height: 300 }) {
  const app = bezelledApp();
  const root = await createRoot({ app });
  root.render(h('window', size, element));
  await settle();
  const tree = app.windows[0]._reactX11Node;
  const trigger = nodes(tree).find((n) => n.props?.role === 'combobox');
  assert.ok(trigger, 'the trigger mounted');
  assert.ok(
    trigger.children.some((c) => c.kind === 'canvas'),
    'the native path: the trigger carries a bezel',
  );
  return { app, root, tree, trigger };
}

async function openMenu(app, trigger) {
  pressButton(
    app.windows[0],
    trigger.abs.x + trigger.abs.width / 2,
    trigger.abs.y + trigger.abs.height / 2,
  );
  await waitFor(() => menuOf(trigger), 'the menu opening');
  const menu = menuOf(trigger);
  await waitFor(
    () => nodes(menu).some((n) => n.props?.role === 'option' && n.abs?.height),
    'the menu laying out its rows',
  );
  return menu;
}

/** The toolbar from the issue: a Select, then a status text the test ticks.
 *  At the top of its window unless `top` gives it room. */
function Toolbar({ value, statusRef, top = 8 }) {
  const [status, setStatus] = React.useState('status 0');
  statusRef.current = setStatus;
  return h(
    'box',
    {
      style: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingTop: top,
        paddingLeft: 8,
      },
    },
    h(Select, { options: OPTIONS, value, onChange: () => {} }),
    h('text', null, status),
  );
}

for (const value of OPTIONS) {
  test(`a native menu near the window's top survives an unrelated re-render — "${value}" chosen`, async () => {
    const statusRef = { current: null };
    const { app, root, tree, trigger } = await mount(
      h(Toolbar, { value, statusRef }),
    );
    await openMenu(app, trigger);

    let passes = 0;
    const unsubscribe = tree.onAnchorChange(() => passes++);
    // a neighbour changing size: a layout pass, and nothing else
    statusRef.current('status 1 — a little longer');
    await waitFor(() => passes > 0, 'a layout pass after the re-render');
    await settle();
    unsubscribe();

    assert.ok(menuOf(trigger), 'the menu is still open');
    assert.equal(trigger.props['aria-expanded'], true);
    await root.unmount();
  });
}

// The offset has to land the menu exactly where `at` did: the chosen row
// over the trigger, whichever row that is. With room above the trigger —
// at the screen's top edge the menu is clamped down, as AppKit clamps it,
// and no row but the first can be over the trigger there.
test('the chosen row opens over the trigger, whichever row it is', async () => {
  const offsets = [];
  for (const value of OPTIONS) {
    const statusRef = { current: null };
    const { app, root, trigger } = await mount(
      h(Toolbar, { value, statusRef, top: 120 }),
    );
    const menu = await openMenu(app, trigger);
    const chosen = nodes(menu).find(
      (n) => n.props?.role === 'option' && n.props['aria-selected'],
    );
    assert.ok(chosen, `row "${value}" is the selected one`);
    const at = screenRect(trigger);
    // screen coordinates: the menu is its own window, placed at x/y
    const rowTop = menu.props.y + chosen.abs.y;
    const rowMiddle = rowTop + chosen.abs.height / 2;
    assert.ok(
      rowMiddle > at.y && rowMiddle < at.y + at.height,
      `row "${value}" (${rowTop}..${rowTop + chosen.abs.height}) is over the trigger (${at.y}..${at.y + at.height})`,
    );
    offsets.push(rowTop - at.y);
    await root.unmount();
  }
  assert.deepEqual(
    offsets,
    OPTIONS.map(() => offsets[0]),
    'and in the same place for every row',
  );
});

// The view test is still there, on the trigger: a scroll that keeps it
// visible moves the menu with it — even though the menu's own top is then
// past the scroll box's edge, which is what used to shut it — and one that
// takes the trigger entirely out of the viewport closes the menu.
test('a native menu follows a scroll while its trigger is visible, and closes once it is not', async () => {
  const scrollRef = React.createRef();
  const row = (key) => h('box', { key, style: { height: 20 } });
  // the scroll box 150px down the window, so the menu has screen to move in
  // rather than being clamped against the top edge
  const { app, root, trigger } = await mount(
    h(
      'box',
      null,
      h('box', { style: { height: 150 } }),
      h(
        'box',
        { ref: scrollRef, style: { overflow: 'scroll', height: 100 } },
        row('before-0'),
        row('before-1'),
        h(Select, { options: OPTIONS, value: 'c', onChange: () => {} }),
        ...Array.from({ length: 10 }, (_, i) => row(`after-${i}`)),
      ),
    ),
    { width: 200, height: 300 },
  );
  const menu = await openMenu(app, trigger);
  const scroller = scrollRef.current;
  assert.ok(scroller.contentHeight > scroller.abs.height, 'content overflows');
  assert.equal(scroller.abs.y, 150);
  assert.equal(trigger.abs.y, 190, 'the trigger sits below two 20px rows');

  // 190..212 → 160..182: inside the scroll box's [150, 250) viewport, with
  // the menu's top — two rows above the trigger — now past the box's edge
  const before = menu.props.y;
  scroller.scrollTo({ y: 30 });
  await waitFor(
    () => menuOf(trigger) && menu.props.y === before - 30,
    `the menu following the scroll (got ${menu.props.y}, want ${before - 30})`,
  );
  assert.ok(menu.props.y < scroller.abs.y, 'the menu starts above the box');

  // 190..212 → 100..122: entirely above it
  scroller.scrollTo({ y: 90 });
  await waitFor(() => !menuOf(trigger), 'the menu closing');
  assert.equal(trigger.props['aria-expanded'], false);
  await root.unmount();
});
