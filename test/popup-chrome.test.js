// The chrome of the floating surfaces: what a menu and a tooltip look like
// on a display that composites, and what they fall back to on one that does
// not. The shape is theme tokens (`radiusPopup` and the two that step in
// from it), the rounding is gated on `@supports transparency` per window,
// and the tooltip's arrow is gated on the *display* — it is part of how big
// the window has to be, so it cannot wait for a style to resolve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot, MenuBar, Select, Tooltip } from '../src/index.js';
import { resolveTheme } from '../src/components/theme.js';
import { setCompositingForTests } from '../src/compositing.js';
import { createMockApp, moveMouse, pressButton } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// the default palette's own numbers, for a 14px body
const RADIUS_POPUP = 7;
const RADIUS_ITEM = 5;
const RADIUS_TOOLTIP = 4;
const ARROW_DEPTH = 6;

/** Ops of the kind `name` recorded on a mock window's context. */
const opsOf = (wnd, name) => wnd.ctx.ops.filter(([op]) => op === name);

// --- the tokens -------------------------------------------------------------

test('the popup radii come from the text size, and an explicit one pins it', () => {
  const base = resolveTheme({ accent: '#333' });
  assert.equal(base.radiusPopup, RADIUS_POPUP, 'untouched by a colour change');
  assert.equal(base.radiusPopupItem, RADIUS_ITEM);
  assert.equal(base.radiusTooltip, RADIUS_TOOLTIP);

  // a palette that moves the type and names no radius gets all three in
  // proportion — half the font, and two steps in from there
  const big = resolveTheme({ fontSize: 20 });
  assert.deepEqual(
    [big.radiusPopup, big.radiusPopupItem, big.radiusTooltip],
    [10, 8, 7],
  );

  const pinned = resolveTheme({ fontSize: 20, radiusPopup: 0 });
  assert.equal(pinned.radiusPopup, 0, 'named explicitly, so not derived');
  assert.equal(pinned.radiusPopupItem, 8, 'the others still are');

  const tight = resolveTheme({ fontSize: 4 });
  assert.equal(tight.radiusTooltip, 0, 'never negative');
});

// --- menus ------------------------------------------------------------------

const MENUS = [
  {
    label: 'File',
    items: [
      { label: 'New' },
      { separator: true },
      {
        label: 'Export',
        items: [{ label: 'PNG' }, { label: 'SVG' }],
      },
      { label: 'Quit' },
    ],
  },
];

async function openMenu({ composited = true } = {}) {
  const app = createMockApp();
  setCompositingForTests(app, composited);
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h(MenuBar, { menus: MENUS, fontSize: 13 }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const item = wnd._reactX11Node.children[0].children[0];
  pressButton(wnd, item.abs.x + 4, item.abs.y + 4);
  await tick();
  await tick();
  const menu = app.windows[1];
  return { app, x11Root, wnd, menu, list: menu?._reactX11Node.children[0] };
}

/**
 * Hover a row of an open menu popup (a mock window), by list index.
 *
 * Generous with ticks: a mousemove is scheduled at continuous priority
 * rather than flushed, and opening a submenu is then a render, an effect
 * that measures, and a second render to place what it measured.
 */
async function hoverRow(popup, index) {
  const row = popup._reactX11Node.children[0].children[index];
  moveMouse(popup, row.abs.x + 4, row.abs.y + 4);
  for (let i = 0; i < 6; i++) await tick();
  return row;
}

test('a menu is an ARGB window and the sheet inside it is rounded', async () => {
  const { x11Root, menu, list } = await openMenu();

  assert.equal(menu.attributes.depth, 32, 'asks for the 32-bit visual');
  assert.equal(menu.attributes.windowType, 'popup_menu');
  // the window paints nothing of its own: a square fill under a rounded
  // sheet would put the corners straight back
  assert.equal(menu._reactX11Node.style.backgroundColor, 'transparent');

  assert.equal(list.style.borderRadius, RADIUS_POPUP);
  assert.equal(list.style.borderWidth, 1, 'a hairline edge, not the theme’s');
  assert.ok(
    opsOf(menu, 'roundRect').some(([, , , , , r]) => r === RADIUS_POPUP),
    'and it really paints a rounded rect',
  );

  await x11Root.unmount();
});

test('with nothing compositing, the same menu is square and opaque', async () => {
  const { x11Root, menu, list } = await openMenu({ composited: false });

  // the visual is still taken — a compositor can start later, and a window
  // cannot change visual once created — but nothing rounds
  assert.equal(menu.attributes.depth, 32);
  assert.equal(list.style.borderRadius, undefined);
  assert.equal(menu._reactX11Node.style.backgroundColor, 'white');
  assert.equal(opsOf(menu, 'clearRect').length, 0, 'never erases to black');

  await x11Root.unmount();
});

test('a menu row is a rounded pill, inset, and paints nothing at rest', async () => {
  const { x11Root, menu, list } = await openMenu();
  const theme = list.theme;
  const [first] = list.children;

  assert.equal(first.style.borderRadius, RADIUS_ITEM, 'tighter than the sheet');
  assert.equal(first.style.backgroundColor, 'transparent', 'nothing at rest');
  // inset from the popup by the list's padding on both sides, which is what
  // makes it read as a pill on the sheet rather than a band across it
  const inset = first.abs.x;
  assert.ok(inset >= 5, `row inset by ${inset}px`);
  assert.equal(first.abs.width, menu.width - inset * 2);
  assert.ok(first.abs.width > menu.width - 16, 'but still nearly menu-wide');

  // hovering it lights it up in the palette's selection colour
  moveMouse(menu, first.abs.x + 4, first.abs.y + 4);
  await tick();
  await tick();
  assert.equal(
    list.children[0].style.backgroundColor,
    theme.hoverBackground,
    'the selection colour, shared with Select and Table',
  );

  await x11Root.unmount();
});

test('a submenu lines its first item up with the row that opened it', async () => {
  const { app, x11Root, menu } = await openMenu();
  const parent = await hoverRow(menu, 2); // 'Export', which has a submenu

  const sub = app.windows[2];
  assert.ok(sub, 'the submenu opened');
  const first = sub._reactX11Node.children[0].children[0];

  // both in screen coordinates: the popup's own y plus the row's y in it
  const parentTop = menu.y + parent.abs.y;
  const firstTop = sub.y + first.abs.y;
  assert.equal(
    firstTop,
    parentTop,
    'the items line up, not the popup edges — the submenu sits a border and ' +
      'a padding higher to pay for its own chrome',
  );
  assert.ok(sub.y < menu.y + parent.abs.y, 'which means the popup is higher');

  await x11Root.unmount();
});

test('the bar item is the first link in the trail', async () => {
  const { x11Root, wnd, menu, list } = await openMenu();
  const item = wnd._reactX11Node.children[0].children[0];
  const theme = list.theme;

  assert.equal(item.style.borderRadius, RADIUS_ITEM, 'the same pill');
  assert.equal(
    item.style.backgroundColor,
    theme.hoverBackground,
    'lit while its menu is open with nothing chosen in it',
  );

  await hoverRow(menu, 0);
  assert.equal(
    item.style.backgroundColor,
    theme.surfaceActive,
    'and quiet once a row down there takes the selection over',
  );

  await x11Root.unmount();
});

test('only the live end of the trail is selection-coloured', async () => {
  const { app, x11Root, menu, list } = await openMenu();
  const theme = list.theme;
  await hoverRow(menu, 2); // 'Export' — its submenu opens with nothing chosen
  const sub = app.windows[2];

  // the pointer is still on the parent row, and so are the keys: it stays lit
  assert.equal(
    list.children[2].style.backgroundColor,
    theme.hoverBackground,
    'a submenu with nothing selected has not taken over',
  );

  await hoverRow(sub, 0); // into the submenu
  assert.equal(
    sub._reactX11Node.children[0].children[0].style.backgroundColor,
    theme.hoverBackground,
    'the row now driving the menus',
  );
  assert.equal(
    list.children[2].style.backgroundColor,
    theme.surfaceActive,
    'and the row it came out of goes quiet rather than claiming it too',
  );
  // quiet, not unselected: it still has to read as the way back
  assert.notEqual(list.children[2].style.backgroundColor, 'transparent');

  await x11Root.unmount();
});

// --- dropdowns --------------------------------------------------------------

test("a Select's menu is the same surface as a menu, and its options the same pill", async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h(
        'box',
        { style: { flexGrow: 1, padding: 10 } },
        h(Select, { options: ['one', 'two', 'three'], value: 'one' }),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const trigger = wnd._reactX11Node.children[0].children[0];
  // opens on the press, as it always has
  pressButton(wnd, trigger.abs.x + 4, trigger.abs.y + 4);
  await tick();
  await tick();

  const menu = app.windows[1];
  const sheet = menu._reactX11Node.children[0];
  assert.equal(menu.attributes.depth, 32, 'ARGB, like a menu');
  assert.equal(menu._reactX11Node.style.backgroundColor, 'transparent');
  assert.equal(sheet.style.borderRadius, RADIUS_POPUP);
  assert.equal(sheet.style.borderWidth, 1, 'the same hairline edge');

  const rows = sheet.children[0].children; // through the scrollview
  const theme = sheet.theme;
  assert.equal(rows[0].style.borderRadius, RADIUS_ITEM);
  assert.equal(
    rows[0].style.backgroundColor,
    theme.hoverBackground,
    'the selected option opens active',
  );
  assert.equal(rows[1].style.backgroundColor, 'transparent', 'and the rest');
  // inset from the sheet on both sides, so the pill sits on it
  assert.ok(rows[0].abs.x >= 5, `option inset by ${rows[0].abs.x}px`);
  assert.equal(rows[0].abs.width, menu.width - rows[0].abs.x * 2);

  await x11Root.unmount();
});

// --- tooltips ---------------------------------------------------------------

async function showTip(
  props = {},
  { composited = true, screen, pad = 60 } = {},
) {
  const app = createMockApp();
  setCompositingForTests(app, composited);
  // the mock models no screen geometry, and `anchorRect` reads that as "no
  // edge to flip at" — a test about which side a hint takes has to say
  if (screen) Object.assign(app.X.display.screen[0], screen);
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h(
        'box',
        { style: { flexGrow: 1, padding: pad } },
        h(
          Tooltip,
          { label: 'Save the file', delay: 10, ...props },
          h('box', { style: { width: 70, height: 24 } }),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const wrapper = wnd._reactX11Node.children[0].children[0];
  moveMouse(wnd, wrapper.abs.x + 5, wrapper.abs.y + 5);
  await after(40);
  await tick();
  return { app, x11Root, wnd, wrapper, tip: app.windows[1] };
}

const ROOMY = { pixel_width: 900, pixel_height: 700 };

test('a tooltip is a rounded bubble with an arrow, and no border', async () => {
  const { x11Root, tip } = await showTip({}, { screen: ROOMY });

  assert.equal(tip.attributes.windowType, 'tooltip');
  assert.equal(tip.attributes.depth, 32);
  const [bubble, arrow] = tip._reactX11Node.children;
  assert.equal(bubble.style.borderRadius, RADIUS_TOOLTIP);
  assert.ok(!bubble.style.borderWidth, 'no border on a hint this small');

  // the popup is the bubble plus the strip the arrow points through, and
  // the bubble sits above it — `direction` resolved to 'top'
  assert.equal(bubble.abs.height, tip.height - ARROW_DEPTH);
  assert.equal(bubble.abs.width, tip.width);
  assert.equal(bubble.abs.y, 0);
  assert.ok(arrow, 'and there is an arrow');
  assert.equal(arrow.abs.y + arrow.abs.height, tip.height);
  // centred on the trigger, which with room on both sides is the middle of
  // the bubble too — to within the half-pixel each rounds away
  const off = arrow.abs.x + arrow.abs.width / 2 - tip.width / 2;
  assert.ok(Math.abs(off) <= 1, `arrow off centre by ${off}px`);

  // a filled triangle, not a rect
  const ops = tip.ctx.ops.map(([op]) => op);
  assert.ok(ops.includes('moveTo') && ops.includes('lineTo'));
  assert.ok(ops.includes('closePath'));

  await x11Root.unmount();
});

test('with nothing compositing, a tooltip is square and has no arrow', async () => {
  const composited = await showTip();
  const plain = await showTip({}, { composited: false });

  assert.equal(plain.tip._reactX11Node.children.length, 1, 'bubble only');
  assert.equal(
    plain.tip._reactX11Node.children[0].style.borderRadius,
    undefined,
  );
  assert.equal(
    plain.tip.height,
    composited.tip.height - ARROW_DEPTH,
    'and the window is exactly the arrow shorter',
  );
  assert.equal(plain.tip.width, composited.tip.width);
  assert.ok(
    !plain.tip.ctx.ops.some(([op]) => op === 'moveTo'),
    'nothing draws a triangle',
  );

  await composited.x11Root.unmount();
  await plain.x11Root.unmount();
});

test('an element label fills a bubble the caller sized', async () => {
  const { x11Root, tip } = await showTip({
    label: h('box', { style: { flexGrow: 1 } }, h('text', null, 'rich')),
    width: 180,
    height: 90,
  });

  assert.equal(tip.width, 180);
  assert.equal(tip.height, 90 + ARROW_DEPTH);
  const [bubble] = tip._reactX11Node.children;
  // no padding imposed on an element: it gets the whole rectangle and draws
  // its own, which is the point of passing one
  assert.equal(bubble.style.paddingLeft, undefined);
  assert.equal(bubble.children[0].abs.width, 180);

  await x11Root.unmount();
});

test('direction="auto" goes above where it fits, and below where it does not', async () => {
  const roomy = await showTip({}, { screen: ROOMY });
  const [above, aboveArrow] = roomy.tip._reactX11Node.children;
  assert.equal(above.abs.y, 0, 'bubble on top…');
  assert.equal(aboveArrow.abs.y + aboveArrow.abs.height, roomy.tip.height);

  // the same hint on a trigger with nothing above it
  const low = await showTip({}, { screen: ROOMY, pad: 8 });
  const [bubble, arrow] = low.tip._reactX11Node.children;
  assert.equal(bubble.abs.y, ARROW_DEPTH, 'bubble pushed down…');
  assert.equal(arrow.abs.y, 0, '…and the arrow points up at the trigger');

  await roomy.x11Root.unmount();
  await low.x11Root.unmount();
});

test('direction="auto" changes axis when neither top nor bottom fits', async () => {
  // a screen too short for the hint either side of the trigger. Only `auto`
  // can answer this one: `anchorRect` flips top for bottom, but it never
  // moves a popup to an axis it was not asked for.
  const { x11Root, tip } = await showTip(
    {},
    { screen: { pixel_width: 900, pixel_height: 96 }, pad: 36 },
  );
  const [bubble, arrow] = tip._reactX11Node.children;

  assert.equal(bubble.abs.width, tip.width - ARROW_DEPTH, 'gone sideways');
  assert.equal(bubble.abs.x, ARROW_DEPTH);
  assert.equal(
    arrow.abs.x,
    0,
    'arrow on the left, pointing back at the trigger',
  );

  await x11Root.unmount();
});

test('a second hint dismisses the first — there is only one pointer', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const trigger = (key) =>
    h(
      Tooltip,
      { key, label: `hint ${key}`, delay: 10 },
      h('box', { style: { width: 70, height: 24 } }),
    );
  x11Root.render(
    h(
      'window',
      { width: 300, height: 200 },
      h('box', { style: { flexGrow: 1, padding: 20, gap: 30 } }, [
        trigger('a'),
        trigger('b'),
      ]),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const [first, second] = wnd._reactX11Node.children[0].children;

  moveMouse(wnd, first.abs.x + 5, first.abs.y + 5);
  await after(40);
  await tick();
  assert.equal(app.windows.length, 2, 'the first hint is up');
  const one = app.windows[1];

  // straight onto the other trigger: the pointer is somewhere else now, so
  // the hint that belongs to where it was goes at once — not at the end of
  // the second one's delay, which would show two at a time
  moveMouse(wnd, second.abs.x + 5, second.abs.y + 5);
  await tick();
  await tick();
  assert.equal(one.destroyed, true, 'the first is gone before the second');

  await after(40);
  await tick();
  const up = app.windows.filter((w) => !w.destroyed && w !== wnd);
  assert.equal(up.length, 1, 'and exactly one hint is showing');

  await x11Root.unmount();
});

test('REACT_X11_NO_TRANSPARENCY=1 gives the opaque design on a display that composites', async () => {
  // the switch has to reach both halves at once: the window's style blocks,
  // and the arrow, which is decided a step earlier because it is part of how
  // big the window is
  process.env.REACT_X11_NO_TRANSPARENCY = '1';
  try {
    const tip = await showTip({}, { screen: ROOMY });
    assert.ok(!('depth' in tip.tip.attributes), 'no ARGB visual taken');
    assert.equal(tip.tip._reactX11Node.children.length, 1, 'no arrow');
    assert.equal(
      tip.tip._reactX11Node.children[0].style.borderRadius,
      undefined,
    );
    await tip.x11Root.unmount();

    const { x11Root, menu, list } = await openMenu();
    assert.equal(list.style.borderRadius, undefined, 'and a square menu');
    assert.equal(menu._reactX11Node.style.backgroundColor, 'white');
    await x11Root.unmount();
  } finally {
    delete process.env.REACT_X11_NO_TRANSPARENCY;
  }
});

test('a named direction grows the popup along its own axis', async () => {
  const right = await showTip({ direction: 'right' }, { screen: ROOMY });
  const down = await showTip({ direction: 'bottom' }, { screen: ROOMY });

  // the arrow is horizontal on a horizontal placement: it takes width there
  // and height here, and the bubble is the rest either way
  const [rightBubble, rightArrow] = right.tip._reactX11Node.children;
  assert.equal(rightBubble.abs.width, right.tip.width - ARROW_DEPTH);
  assert.equal(rightBubble.abs.height, right.tip.height);
  assert.equal(rightArrow.abs.x, 0, 'arrow on the edge facing the trigger');

  const [downBubble] = down.tip._reactX11Node.children;
  assert.equal(downBubble.abs.height, down.tip.height - ARROW_DEPTH);
  assert.equal(right.tip.width, down.tip.width + ARROW_DEPTH);

  await right.x11Root.unmount();
  await down.x11Root.unmount();
});
