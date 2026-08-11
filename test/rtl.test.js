// RTL (issue #271): the layout mirrors, and it mirrors *whole*.
//
// The half-mirrored state is the one this exists to make impossible — boxes
// that flow the other way with every padding still on the physically-left
// side reads as a bug in a way that no support at all does not. So the two
// halves are tested together: the direction that reaches yoga, and the
// logical edges a stylesheet written for both directions is spelled in.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import {
  createRoot,
  Slider,
  SplitPane,
  Tabs,
  ThemeProvider,
} from '../src/index.js';
import { anchorRect } from '../src/components/anchor.js';
import { localeDirection } from '../src/palette.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};
const rootOf = (app) => app.windows[0]._reactX11Node;

const XK = { LEFT: 0xff51, RIGHT: 0xff53 };

function press(app, wnd, keysym) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  wnd.emit('keydown', { keycode, codepoint: 0, buttons: 0 });
}

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

async function mount(element) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(element);
  await settle();
  return { app, root: rootOf(app), x11Root };
}

const window300 = (style, ...children) =>
  h('window', { width: 300, height: 120, style }, ...children);

// --- the direction itself ---------------------------------------------------

test('a row of boxes lays out right-to-left under direction: rtl', async () => {
  const row = (direction) =>
    window300(
      { direction },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        h('box', { style: { width: 40, height: 20 } }),
        h('box', { style: { width: 40, height: 20 } }),
        h('box', { style: { width: 40, height: 20 } }),
      ),
    );

  const ltr = await mount(row('ltr'));
  const xs = (r) =>
    find(r, (n) => n.style.flexDirection === 'row').children.map(
      (c) => c.abs.x,
    );
  assert.deepStrictEqual(xs(ltr.root), [0, 40, 80], 'ltr is unchanged');

  const rtl = await mount(row('rtl'));
  assert.deepStrictEqual(
    xs(rtl.root),
    [260, 220, 180],
    'the first child is against the right edge and the row runs left',
  );
});

test('direction on an inner box mirrors that subtree only', async () => {
  const { root } = await mount(
    window300(
      undefined,
      h(
        'box',
        { style: { flexDirection: 'row' } },
        h('box', { style: { width: 40, height: 20 } }),
        h(
          'box',
          {
            style: {
              direction: 'rtl',
              flexDirection: 'row',
              width: 200,
              height: 20,
            },
          },
          h('box', { style: { width: 30, height: 20 } }),
          h('box', { style: { width: 30, height: 20 } }),
        ),
      ),
    ),
  );
  const outer = root.children[0];
  assert.strictEqual(outer.direction, 'ltr', 'the outer row is untouched');
  assert.strictEqual(outer.children[0].abs.x, 0, 'and lays out from the left');
  const inner = outer.children[1];
  assert.strictEqual(inner.direction, 'rtl');
  assert.strictEqual(inner.abs.x, 40, 'the mirrored box itself does not move');
  assert.deepStrictEqual(
    inner.children.map((c) => c.abs.x),
    [210, 180],
    'only what is inside it runs the other way',
  );
});

test('the resolved direction inherits, and a node states its own', async () => {
  const { root } = await mount(
    window300(
      { direction: 'rtl' },
      h(
        'box',
        { style: { direction: 'ltr' } },
        h('box', { style: { height: 4 } }),
      ),
    ),
  );
  assert.strictEqual(root.direction, 'rtl');
  assert.strictEqual(root.children[0].direction, 'ltr', 'the node states it');
  assert.strictEqual(
    root.children[0].children[0].direction,
    'ltr',
    'and everything below takes it from there',
  );
});

// --- logical edges ----------------------------------------------------------

test('paddingStart resolves to the leading edge, and beats paddingLeft', async () => {
  // Yoga's edge precedence is start/end over the physical side over
  // EDGE_HORIZONTAL over EDGE_ALL — the *opposite* way round from what the
  // vertical shorthands suggest, and the whole reason a stylesheet can be
  // written in logical edges and still carry a physical override for one
  // case. Pinned rather than assumed.
  const padded = (direction) =>
    window300(
      { direction },
      h(
        'box',
        { style: { paddingStart: 20, paddingLeft: 9, paddingRight: 9 } },
        h('box', { style: { height: 10 } }),
      ),
    );

  const ltr = await mount(padded('ltr'));
  assert.strictEqual(
    ltr.root.children[0].children[0].abs.x,
    20,
    'in ltr the start is the left edge, and paddingStart wins there',
  );

  const rtl = await mount(padded('rtl'));
  const inner = rtl.root.children[0].children[0];
  assert.strictEqual(
    inner.abs.x,
    9,
    'in rtl the left inset is the physical paddingLeft that is left over',
  );
  assert.strictEqual(
    inner.abs.x + inner.abs.width,
    300 - 20,
    'and the 20 has moved to the right edge',
  );
});

test('marginStart and a start inset mirror with the direction', async () => {
  const shifted = (direction) =>
    window300(
      { direction },
      h('box', {
        style: {
          position: 'absolute',
          start: 10,
          marginStart: 5,
          width: 40,
          height: 20,
        },
      }),
    );
  const ltr = await mount(shifted('ltr'));
  assert.strictEqual(ltr.root.children[0].abs.x, 15);
  const rtl = await mount(shifted('rtl'));
  assert.strictEqual(
    rtl.root.children[0].abs.x,
    300 - 15 - 40,
    'both are measured from the right edge instead',
  );
});

test('borderStartWidth insets the content on the leading side', async () => {
  const bordered = (direction) =>
    window300(
      { direction },
      h(
        'box',
        { style: { borderStartWidth: 6, borderColor: '#c0392b' } },
        h('box', { style: { flexGrow: 1, height: 10 } }),
      ),
    );
  const ltr = await mount(bordered('ltr'));
  assert.strictEqual(ltr.root.children[0].children[0].abs.x, 6);
  const rtl = await mount(bordered('rtl'));
  const inner = rtl.root.children[0].children[0];
  assert.strictEqual(inner.abs.x, 0, 'nothing on the left');
  assert.strictEqual(
    inner.abs.x + inner.abs.width,
    300 - 6,
    'the bar is on the right, and it is layout rather than an overlay',
  );
});

// --- what reads the resolved direction --------------------------------------

test('a scrolling box puts its vertical scrollbar on the left in rtl', async () => {
  const scroller = (direction) =>
    window300(
      { direction },
      h(
        'box',
        { style: { overflow: 'scroll', width: 100, height: 50 } },
        h('box', { style: { height: 400 } }),
      ),
    );

  const ltr = await mount(scroller('ltr'));
  const ltrBar = ltr.root.children[0]._scrollbar('y');
  assert.ok(ltrBar, 'there is something to scroll');
  assert.ok(ltrBar.crossStart > 80, 'ltr: against the right edge');

  const rtl = await mount(scroller('rtl'));
  const box = rtl.root.children[0];
  const bar = box._scrollbar('y');
  assert.strictEqual(
    bar.crossStart,
    box.abs.x + 2,
    'rtl: against the left edge, at the same inset',
  );
});

test('rtl horizontal scrolling counts from the right-hand edge', async () => {
  const { root } = await mount(
    window300(
      { direction: 'rtl' },
      h(
        'box',
        {
          style: {
            overflow: 'scroll',
            flexDirection: 'row',
            width: 100,
            height: 50,
          },
        },
        h('box', { style: { width: 160, height: 20, flexShrink: 0 } }),
      ),
    ),
  );
  const box = root.children[0];
  const child = box.children[0];
  assert.strictEqual(
    box.contentWidth,
    160,
    'the content reach is 160 either way',
  );
  assert.strictEqual(
    child.abs.x + child.abs.width,
    box.abs.x + box.abs.width,
    'scrollX 0 means "at the start", which is the right-hand edge',
  );

  box.scrollTo({ x: 60 });
  await settle();
  assert.strictEqual(
    child.abs.x + child.abs.width,
    box.abs.x + box.abs.width + 60,
    'scrolling forward drags the content to the right, out past the start',
  );

  const bar = box._scrollbar('x');
  assert.ok(bar.reversed, 'and its thumb runs the other way down the track');
});

// --- widgets ----------------------------------------------------------------

test('Slider mirrors its thumb, its drag and its arrow keys', async () => {
  const { app, root } = await mount(
    window300(
      { direction: 'rtl' },
      h(Slider, { value: 0, min: 0, max: 100, onChange: () => {} }),
    ),
  );
  const track = root.children[0];
  const thumb = track.children[1];
  assert.strictEqual(
    thumb.abs.x + thumb.abs.width,
    track.abs.x + track.abs.width,
    'at value 0 the thumb is at the right-hand end',
  );

  // the keys: Left is the one that raises the value in a mirrored slider.
  // Held at 50 rather than at an end, so neither step is swallowed by the
  // clamp and the two are each other's mirror.
  const changes = [];
  const { root: keyed, app: keyApp } = await mount(
    window300(
      { direction: 'rtl' },
      h(Slider, {
        value: 50,
        min: 0,
        max: 100,
        step: 5,
        onChange: (ev) => changes.push(ev.value),
      }),
    ),
  );
  keyed.children[0].focus();
  press(keyApp, keyApp.windows[0], XK.LEFT);
  press(keyApp, keyApp.windows[0], XK.RIGHT);
  assert.deepStrictEqual(
    changes,
    [55, 45],
    'Left raises and Right lowers when the track runs the other way',
  );
  void app;
});

test('Tabs walk the strip in the direction it is drawn', async () => {
  const picked = [];
  const { app, root } = await mount(
    window300(
      { direction: 'rtl' },
      h(ThemeProvider, {
        value: { direction: 'rtl' },
        children: h(Tabs, {
          items: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
          value: 'a',
          onChange: (id) => picked.push(id),
        }),
      }),
    ),
  );
  const strip = find(root, (n) => n.props.role === 'tablist');
  strip.children[0].focus();
  press(app, app.windows[0], XK.LEFT);
  assert.deepStrictEqual(picked, ['b'], 'Left is the next tab along');
});

test('SplitPane reads a drag from the edge its first pane starts at', async () => {
  const sizes = [];
  const { root } = await mount(
    window300(
      { direction: 'rtl' },
      h(ThemeProvider, {
        value: { direction: 'rtl' },
        children: h(SplitPane, {
          defaultSize: 100,
          onResize: (n) => sizes.push(n),
          children: [h('box', { key: 'a' }), h('box', { key: 'b' })],
        }),
      }),
    ),
  );
  const divider = find(root, (n) => n.props.role === 'separator');
  assert.ok(divider, 'the divider is there');
  const box = find(
    root,
    (n) => n.props.role === undefined && n.children.length === 3,
  )?.abs;
  // press in the middle of the divider, then drag 40px towards the *left*,
  // which in a mirrored split is 40px more for the first pane
  const at = (x) => ({
    x,
    y: divider.abs.y + divider.abs.height / 2,
    button: 1,
    capturePointer() {},
  });
  divider.props.onMouseDown(at(divider.abs.x + divider.abs.width / 2));
  divider.props.onMouseMove(at(divider.abs.x + divider.abs.width / 2 - 40));
  assert.deepStrictEqual(sizes, [140], 'dragging left grows the first pane');
  void box;
});

// --- popups -----------------------------------------------------------------

test('a submenu opens to the start side, and flips at the screen edge', () => {
  // a node standing in for a laid-out menu row, with a screen to clamp into
  const node = (direction, x) => ({
    direction,
    abs: { x, y: 40, width: 120, height: 24 },
    root: { window: { x: 0, y: 0 } },
    app: { display: { screen: [{ pixel_width: 800, pixel_height: 600 }] } },
  });

  const ltr = anchorRect(node('ltr', 100), {
    placement: 'end',
    width: 150,
    height: 100,
  });
  assert.strictEqual(ltr.placement, 'right', 'ltr: out to the right');
  assert.strictEqual(ltr.x, 100 + 120 + 2);

  const rtl = anchorRect(node('rtl', 400), {
    placement: 'end',
    width: 150,
    height: 100,
  });
  assert.strictEqual(rtl.placement, 'left', 'rtl: out to the left');
  assert.strictEqual(rtl.x, 400 - 150 - 2);

  // …and the flip still happens when the preferred side has no room
  const squeezed = anchorRect(node('rtl', 10), {
    placement: 'end',
    width: 150,
    height: 100,
  });
  assert.strictEqual(squeezed.placement, 'right', 'no room on the left');
});

test('align: start is the right-hand edge under rtl', () => {
  const node = {
    direction: 'rtl',
    abs: { x: 100, y: 40, width: 200, height: 24 },
    root: { window: { x: 0, y: 0 } },
    app: { display: { screen: [{ pixel_width: 800, pixel_height: 600 }] } },
  };
  const rect = anchorRect(node, { placement: 'bottom', width: 80, height: 50 });
  assert.strictEqual(
    rect.x,
    100 + 200 - 80,
    'the popup lines up with the trigger’s start, which is its right edge',
  );
});

// --- where the root direction comes from ------------------------------------

test('the palette is the floor, and a provider that names one plants it', async () => {
  const { root } = await mount(
    h(
      'window',
      { width: 300, height: 120, theme: { direction: 'rtl' } },
      h(
        'box',
        { style: { flexDirection: 'row' } },
        h('box', { style: { width: 40, height: 20 } }),
      ),
    ),
  );
  assert.strictEqual(root.direction, 'rtl', 'a theme prop reaches the root');
  assert.strictEqual(
    root.children[0].children[0].abs.x,
    260,
    'and the root hands it to calculateLayout, so the tree mirrors',
  );
});

test('ThemeProvider mirrors the boxes under it as well as the widgets', async () => {
  const { root } = await mount(
    window300(
      undefined,
      h(ThemeProvider, {
        value: { direction: 'rtl' },
        children: h(
          'box',
          { style: { flexDirection: 'row' } },
          h('box', { style: { width: 40, height: 20 } }),
        ),
      }),
    ),
  );
  const planted = root.children[0];
  assert.strictEqual(
    planted.direction,
    'rtl',
    'the provider plants the style, not only the palette',
  );
  assert.strictEqual(planted.children[0].children[0].abs.x, 260);
});

test('the locale seeds the default', () => {
  assert.strictEqual(localeDirection({ LANG: 'en_GB.UTF-8' }), 'ltr');
  assert.strictEqual(localeDirection({ LANG: 'C' }), 'ltr');
  assert.strictEqual(localeDirection({}), 'ltr', 'no locale at all is ltr');
  assert.strictEqual(localeDirection({ LANG: 'ar_EG.UTF-8' }), 'rtl');
  assert.strictEqual(localeDirection({ LANG: 'he-IL' }), 'rtl');
  assert.strictEqual(localeDirection({ LANG: 'fa' }), 'rtl');
  assert.strictEqual(
    localeDirection({ LC_ALL: 'ur_PK.UTF-8', LANG: 'en_US.UTF-8' }),
    'rtl',
    'LC_ALL outranks LANG',
  );
  assert.strictEqual(
    localeDirection({ LC_MESSAGES: 'he_IL', LANG: 'en_US' }),
    'rtl',
    '…and LC_MESSAGES outranks LANG too — it is the one that picks the words',
  );
});

// --- paint ------------------------------------------------------------------

test('a logical border paints on the side it laid out on', async () => {
  // The layout half is asserted above; this is the other one. The two are
  // resolved by the same function for exactly this reason — a border that
  // reserves space on one side and strokes the other is a gap along the edge
  // of the box, which no amount of layout testing would find.
  const seen = [];
  const { root } = await mount(
    window300(
      { direction: 'rtl' },
      h('box', {
        style: {
          borderStartWidth: 4,
          borderStartColor: '#c0392b',
          borderEndColor: '#27ae60',
          width: 100,
          height: 40,
        },
      }),
    ),
  );
  const box = root.children[0];
  box._paintBorderSides = (ctx, w, colors) => seen.push({ w, colors });
  box._paintBorder({});
  assert.strictEqual(seen.length, 1, 'a one-sided border is not uniform');
  assert.strictEqual(seen[0].w.right, 4, 'the width went to the right side');
  assert.strictEqual(seen[0].w.left, 0);
  assert.strictEqual(seen[0].colors.right, '#c0392b', 'and so did its colour');
  assert.strictEqual(seen[0].colors.left, '#27ae60', 'the end colour is left');
});

test('a text node hands its base direction to the shaper', async () => {
  const asked = [];
  const app = createMockApp();
  app.fonts = {
    layout: (spans, base, options) => {
      asked.push(options);
      return { width: 10, height: 10, lines: [], draw() {} };
    },
  };
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 300, height: 120, style: { direction: 'rtl' } },
      h('text', { style: { textAlign: 'start' } }, 'שלום'),
    ),
  );
  await settle();
  assert.ok(asked.length > 0, 'the text was laid out');
  assert.strictEqual(
    asked[0].direction,
    'rtl',
    'UAX#9 resolves neutrals against the paragraph level, so the box has to ' +
      'say what it is — and `textAlign: start` is resolved from it too',
  );
});
