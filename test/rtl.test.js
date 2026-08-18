// RTL (issue #271): the layout mirrors, and it mirrors *whole*.
//
// The half-mirrored state is the one this exists to make impossible — boxes
// that flow the other way with every padding still on the physically-left
// side reads as a bug in a way that no support at all does not. So the two
// halves are tested together: the direction that reaches yoga, and the
// logical edges a stylesheet written for both directions is spelled in.
//
// The last section is the same claim for the inside of an editable field
// (issue #341), where the base direction is not only about which edge the
// text is against: it is the level UAX#9 resolves brackets, digits and
// dashes at, so a field that never states one reorders mixed content
// wrongly in an *LTR* window too.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
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
import {
  act,
  cleanup,
  countPixels,
  renderX11,
  userEvent,
} from '../src/testing/index.js';

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

// --- inside a field (issue #341) ---------------------------------------------
//
// `<text>` above proves the base direction reaches the shaper. These prove the
// same for `<textinput>`/`<textarea>`, and then the half a paragraph does not
// have: a field is a viewport over its value, so where the value is placed,
// where a click lands in it and which way it scrolls all have to mirror
// together — `_placedValue()` is the one function they are all read from, and
// a test per reader is what stops them drifting apart.

const require = createRequire(import.meta.url);
const FONT = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
  'KaTeX_Main-Regular.ttf',
);
// Pixel assertions need a font that is the same file on every machine —
// `fc-match` is a different answer per box and no answer in a container. The
// Arabic below has no glyphs in it and draws as notdef boxes, which is fine
// and is the point: bidi is decided by the *characters*, so the ordering
// under test is the same ordering a font with Arabic in it would shape.
const fonts = { 'sans-serif': FONT };
// A run of neutrals — brackets, digits, a colon, a dash — in front of a
// strong RTL word. Exactly the string the first-strong-character rule gets
// wrong: it resolves the paragraph as RTL and mirrors the brackets.
const MIXED = '(1) 12:30 — نص';

afterEach(cleanup);

/** The visual run order, as logical ranges: `[[start, end], …]` left to
 * right. What "the same glyph order" means when the glyphs are notdef. */
const runOrder = (layout) => layout.lines[0].runs.map((r) => [r.start, r.end]);

/** How much of a region is *not* the background — the ink, counted rather
 * than sampled, since the question is which half of the box it is in. */
const inkIn = async (ctx, region, background = '#ffffff') =>
  region.width * region.height - (await countPixels(ctx, region, background));

/** A window at `direction` with one field in it, over a white background. */
async function fieldWindow(direction, props, kind = 'textinput') {
  const view = await renderX11(
    h(
      'window',
      {
        width: 300,
        height: 90,
        style: { direction, padding: 10, backgroundColor: '#ffffff' },
      },
      h('text', { 'data-testname': 'para', style: { fontSize: 14 } }, MIXED),
      h(kind, {
        role: 'textbox',
        'data-testname': 'field',
        style: { width: 240, fontSize: 14, color: '#000000' },
        ...props,
      }),
    ),
    { fonts, width: 300, height: 90 },
  );
  return { ...view, field: view.getByTestName('field') };
}

test('a field lays its value out at the box direction, not at the first strong character', async () => {
  // The LTR half of #341, and the half that is wrong in the direction almost
  // everyone runs in: an Arabic word in an English form makes the *first
  // strong character* Arabic, so a paragraph with no stated base level comes
  // out RTL and `(1) 12:30` renders as `)1( 12:30`.
  for (const direction of ['ltr', 'rtl']) {
    const { field, getByTestName } = await fieldWindow(direction, {
      value: MIXED,
    });
    const paragraph = getByTestName('para');
    assert.deepStrictEqual(
      runOrder(field._valueLayout()),
      runOrder(paragraph._layoutFor(Infinity)),
      `the field and the <text> reorder ${direction} identically`,
    );
    await cleanup();
  }

  // …and what that ordering *is*, so the two agreeing on the wrong answer
  // would still fail: under `ltr` the leading neutrals stay leading.
  const { field } = await fieldWindow('ltr', { value: MIXED });
  assert.deepStrictEqual(
    runOrder(field._valueLayout())[0],
    [0, 4],
    'the brackets and the digit are the leftmost thing on the line',
  );
});

test('an RTL field puts its value, and its placeholder, against the right edge', async () => {
  for (const [direction, half] of [
    ['ltr', 'left'],
    ['rtl', 'right'],
  ]) {
    for (const props of [{ value: 'Latin' }, { placeholder: 'Latin' }]) {
      const { field, ctx } = await fieldWindow(direction, props);
      const content = field.contentBox();
      const width = Math.floor(content.width / 2);
      const band = { y: field.abs.y, width, height: field.abs.height };
      const left = await inkIn(ctx, { ...band, x: content.x });
      const right = await inkIn(ctx, { ...band, x: content.x + width });
      const what = Object.keys(props)[0];
      if (half === 'left') {
        assert.ok(left > 0 && right === 0, `${direction}: ${what} on the left`);
      } else {
        assert.ok(
          right > 0 && left === 0,
          `${direction}: ${what} on the right`,
        );
      }
      await cleanup();
    }
  }
});

test('an empty RTL field blinks its caret at the right edge of the content box', async () => {
  for (const direction of ['ltr', 'rtl']) {
    const { field, ctx } = await fieldWindow(direction, { defaultValue: '' });
    const content = field.contentBox();
    // The caret is a rectangle drawn *rightwards* from the boundary it marks,
    // so an RTL field has to keep its own width free at the flush edge or the
    // one thing an empty field draws lands outside the clip.
    const right = content.x + content.width;
    const caret = field.textCaretRect(0);
    if (direction === 'ltr') {
      assert.strictEqual(caret.x, content.x, 'ltr: at the left edge');
    } else {
      assert.ok(
        caret.x < right && caret.x >= right - 3,
        `rtl: within a caret of the right edge, got ${caret.x} against ${right}`,
      );
    }

    // and it is painted where the accessor says, which is the assertion the
    // geometry alone cannot make
    await userEvent.click(field);
    field._repaint();
    await act();
    const band = {
      y: field.abs.y,
      width: Math.floor(content.width / 2),
      height: field.abs.height,
    };
    const near = await inkIn(ctx, {
      ...band,
      x: direction === 'rtl' ? content.x + band.width : content.x,
    });
    const far = await inkIn(ctx, {
      ...band,
      x: direction === 'rtl' ? content.x : content.x + band.width,
    });
    assert.ok(near > 0, `${direction}: the caret is drawn on the start side`);
    assert.strictEqual(far, 0, `${direction}: and nothing is on the other`);
    await cleanup();
  }
});

test('a click in an RTL field lands where the text is, not where it would be in LTR', async () => {
  // The hit test and the paint are the pair that silently drift: a value
  // placed on the right and hit-tested from the left puts the caret in a
  // different character from the one under the pointer, and nothing about
  // the screen says so until someone types.
  for (const [direction, expected] of [
    ['ltr', 5],
    ['rtl', 0],
  ]) {
    const { field } = await fieldWindow(direction, { value: 'Latin' });
    const content = field.contentBox();
    const middle = content.x + content.width / 2;
    assert.strictEqual(
      field.textIndexAt(middle, content.y + 2),
      expected,
      `${direction}: the middle of the box is ${expected === 0 ? 'before' : 'after'} a short value`,
    );
    // …and the caret the click asks for is drawn back at the click's own end
    // of the box, which is what proves the two read one geometry
    const caret = field.textCaretRect(expected);
    const side = direction === 'rtl' ? caret.x > middle : caret.x < middle;
    assert.ok(side, `${direction}: the caret is on the value's own side`);
    await cleanup();
  }
});

test('an overflowing RTL field scrolls from the right, and _scrollX still counts from the start', async () => {
  // `_scrollX: 0` means "showing the beginning of the value" in both
  // directions — the rule a scroll box already follows — so in RTL it is the
  // *right-hand* end that is showing and the text overflows to the left.
  //
  // The value is Arabic rather than Latin because that is what makes the
  // sentence above one sentence: the paragraph's start edge is the right,
  // and the *string's* start is only there too when the string reads that
  // way. Latin in an RTL field is one LTR run placed against that same right
  // edge, so what overflows is its beginning — which is what a browser shows
  // for `<input dir="rtl">` too, and is the placement working rather than
  // failing.
  const long =
    'نص طويل جدا لا يتسع داخل هذا الحقل الصغير أبدا وهو كذلك ولا يزال طويلا جدا';
  const { field } = await fieldWindow('rtl', { value: long });
  const content = field.contentBox();
  const layout = field._valueLayout();
  assert.ok(layout.width > content.width, 'the premise: it overflows');
  assert.strictEqual(field._scrollX, 0, 'an unfocused field shows the start');
  assert.ok(
    field._placedValue().x + layout.width > content.x + content.width - 4,
    'the start of the value is against the right edge, the rest runs left',
  );

  // typing at the end pulls the far end of the value into view, which in RTL
  // means the text moves *right* rather than left
  const before = field._placedValue().x;
  await userEvent.click(field);
  field._caret = Array.from(long).length;
  field._repaint();
  await act();
  assert.ok(field._scrollX > 0, 'the caret chase scrolled to the end');
  assert.ok(
    field._placedValue().x > before,
    'and it displaced the text to the right, not to the left',
  );
  assert.ok(
    field.textCaretRect(field._caret).x >= content.x - 1,
    'the caret it chased is inside the box',
  );
});

test('the arrow keys and Home/End stay logical under either direction', async () => {
  // Deliberately *not* mirrored. Left/Right step through the string rather
  // than across the screen, which is what Home/End already do and what the
  // editing model is written in; visual-order caret motion through bidi text
  // is a separate question from where the field draws (issue #272's half).
  for (const direction of ['ltr', 'rtl']) {
    const { field } = await fieldWindow(direction, { value: 'Latin' });
    await userEvent.click(field);
    await userEvent.key(0xff50); // Home
    assert.strictEqual(field._caret, 0, `${direction}: Home is the start`);
    await userEvent.key(XK.RIGHT);
    assert.strictEqual(field._caret, 1, `${direction}: Right steps forward`);
    await userEvent.key(XK.LEFT);
    assert.strictEqual(field._caret, 0, `${direction}: Left steps back`);
    await userEvent.key(0xff57); // End
    assert.strictEqual(field._caret, 5, `${direction}: End is the end`);
    await cleanup();
  }
});

test('a <textarea> aligns its wrapped lines at the base direction', async () => {
  // The field with a container of its own: it wraps, so the alignment is
  // ntk's to apply inside the layout rather than the placement's, and the
  // two elements have to arrive at the same screen.
  for (const direction of ['ltr', 'rtl']) {
    const { field } = await fieldWindow(
      direction,
      { value: 'one two three four five six seven eight nine ten', rows: 3 },
      'textarea',
    );
    const layout = field._valueLayout();
    const content = field.contentBox();
    assert.ok(layout.lines.length > 1, 'the premise: it wrapped');
    const shortest = layout.lines.reduce((a, l) => (l.width < a.width ? l : a));
    if (direction === 'ltr') {
      assert.strictEqual(shortest.x, 0, 'ltr: every line starts at the left');
    } else {
      assert.ok(
        shortest.x > 0,
        `rtl: a short line is pushed right, got x ${shortest.x}`,
      );
      // and the caret at the start of a line is inside the box rather than
      // on the far side of the clip — the reserve the container leaves
      const caret = field.textCaretRect(0);
      assert.ok(
        caret.x <= content.x + content.width - 1,
        `rtl: the line-start caret is inside the content box, got ${caret.x}`,
      );
    }
    await cleanup();
  }
});
