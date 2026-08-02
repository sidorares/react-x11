// Dragging the scrollbar with the pointer: the thumb follows the pointer,
// the track pages, and the bar belongs to the scroller rather than to the
// content painted under it.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 10 rows of 40 in a 100-tall viewport: 400 of content, 300 of scroll range
async function mount() {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'scrollview',
        { ref, style: { flexGrow: 1 } },
        ...Array.from({ length: 10 }, (_, i) =>
          h('box', { key: i, style: { height: 40, flexShrink: 0 } }),
        ),
      ),
    ),
  );
  return { app, wnd: app.windows[0] };
}

const scroller = (app) => app.windows[0]._reactX11Node.children[0];

const drag = (wnd, from, to) => {
  wnd.emit('mousedown', { x: from.x, y: from.y, keycode: 1 });
  wnd.emit('mousemove', { x: to.x, y: to.y });
  wnd.emit('mouseup', { x: to.x, y: to.y, keycode: 1 });
};

test('dragging the thumb scrolls in proportion to the pointer', async () => {
  const { app, wnd } = await mount();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();
  assert.ok(bar, 'the bar shows when the content overflows');
  assert.strictEqual(sv.scrollY, 0);

  // grab the middle of the thumb and take it half way down the travel
  wnd.emit('mousedown', {
    x: bar.x + 2,
    y: bar.thumbStart + bar.thumbLength / 2,
    keycode: 1,
  });
  wnd.emit('mousemove', {
    x: bar.x + 2,
    y: bar.thumbStart + bar.thumbLength / 2 + bar.travel / 2,
  });
  assert.ok(
    Math.abs(sv.scrollY - bar.range / 2) < 1,
    `half the travel should be half the range, got ${sv.scrollY}`,
  );

  // and past the end clamps rather than overscrolling
  wnd.emit('mousemove', { x: bar.x + 2, y: 10_000 });
  assert.strictEqual(sv.scrollY, bar.range);

  wnd.emit('mouseup', { x: bar.x + 2, y: 10_000, keycode: 1 });
  await x11Root.unmount();
});

test('the drag keeps its grip on the thumb, without jumping', async () => {
  const { app, wnd } = await mount();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();

  // press near the *bottom* of the thumb and do not move: nothing should
  // happen — a jump-to-pointer implementation would scroll here
  wnd.emit('mousedown', {
    x: bar.x + 2,
    y: bar.thumbStart + bar.thumbLength - 1,
    keycode: 1,
  });
  assert.strictEqual(sv.scrollY, 0, 'grabbing the thumb does not move it');
  wnd.emit('mouseup', { x: bar.x + 2, y: bar.thumbStart, keycode: 1 });

  await x11Root.unmount();
});

test('a press on the track pages towards the pointer', async () => {
  const { app, wnd } = await mount();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();

  wnd.emit('mousedown', {
    x: bar.x + 2,
    y: bar.trackStart + bar.trackLength - 2,
    keycode: 1,
  });
  assert.strictEqual(sv.scrollY, 100, 'one viewport down');
  wnd.emit('mouseup', { x: bar.x + 2, y: bar.trackStart, keycode: 1 });

  wnd.emit('mousedown', { x: bar.x + 2, y: bar.trackStart + 1, keycode: 1 });
  assert.strictEqual(sv.scrollY, 0, 'and back up again');

  await x11Root.unmount();
});

test('the bar takes the press even with content painted under it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const clicks = [];
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'scrollview',
        { style: { flexGrow: 1 } },
        ...Array.from({ length: 10 }, (_, i) =>
          h('box', {
            key: i,
            style: { height: 40, flexShrink: 0 },
            onClick: () => clicks.push(i),
          }),
        ),
      ),
    ),
  );
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();

  drag(
    app.windows[0],
    { x: bar.x + 2, y: bar.thumbStart + 2 },
    { x: bar.x + 2, y: bar.thumbStart + 2 },
  );
  assert.deepStrictEqual(clicks, [], 'the row under the bar was not clicked');

  // a press just inside the content does still reach the row
  drag(app.windows[0], { x: 10, y: 10 }, { x: 10, y: 10 });
  assert.deepStrictEqual(clicks, [0]);

  await x11Root.unmount();
});

test('a <textarea> bar drag scrolls it, and never moves the caret', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 80 },
      h('textarea', { value: 'many lines', style: { flexGrow: 1 } }),
    ),
  );
  await tick();

  const area = app.windows[0]._reactX11Node.children[0];
  // the mock has no font metrics, so stand in for the laid-out text: all
  // the bar needs from it is a height
  area._valueLayout = () => ({
    height: 600,
    // enough of a layout for the bar; painting asks for the caret too
    caretPosition: () => ({ x: 0, y: 0, height: 12 }),
    lines: [],
  });

  const bar = area._scrollbar();
  assert.ok(bar, 'text taller than the box gets a thumb');
  const caretBefore = area._caret;

  area._defaultMouseDown({
    x: bar.x + 2,
    y: bar.thumbStart + 2,
    capturePointer() {},
  });
  area._defaultMouseDrag({
    x: bar.x + 2,
    y: bar.thumbStart + 2 + bar.travel / 2,
  });
  assert.strictEqual(area._caret, caretBefore, 'the caret stayed put');
  assert.ok(
    Math.abs(area._scrollY - bar.range / 2) < 1,
    `half the travel is half the range, got ${area._scrollY}`,
  );

  area._defaultMouseDrag({ x: bar.x + 2, y: 10_000 });
  assert.strictEqual(area._scrollY, bar.range, 'and clamps at the end');
  area._defaultMouseUp({});

  // a press in the text still reaches the caret logic
  area._scrollY = 0;
  const content = area.contentBox();
  let placed = false;
  area._indexAtPoint = () => {
    placed = true;
    return 3;
  };
  area._defaultMouseDown({ x: content.x + 5, y: content.y + 5, detail: 1 });
  assert.ok(placed, 'a press away from the bar still places the caret');

  await x11Root.unmount();
});

// --- horizontal ------------------------------------------------------------

/** A row of fixed-width cells: wider than the viewport, and unable to
 * shrink, which is what a table of columns looks like. */
async function mountWide() {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'scrollview',
        { ref, style: { flexGrow: 1 } },
        h(
          'box',
          { style: { flexDirection: 'row', flexShrink: 0 } },
          ...Array.from({ length: 6 }, (_, i) =>
            h('box', {
              key: i,
              style: { width: 100, height: 40, flexShrink: 0 },
            }),
          ),
        ),
      ),
    ),
  );
  return { app, wnd: app.windows[0], ref };
}

test('content wider than the viewport scrolls sideways', async () => {
  const { app, wnd } = await mountWide();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);

  assert.strictEqual(sv.contentWidth, 600, 'six 100px cells');
  const bar = sv._scrollbar('x');
  assert.ok(bar, 'a horizontal bar appears');
  assert.strictEqual(bar.axis, 'x');
  assert.strictEqual(bar.range, 600 - 200);

  wnd.emit('mousedown', {
    x: bar.thumbStart + bar.thumbLength / 2,
    y: bar.crossStart + 2,
    keycode: 1,
  });
  wnd.emit('mousemove', {
    x: bar.thumbStart + bar.thumbLength / 2 + bar.travel / 2,
    y: bar.crossStart + 2,
  });
  assert.ok(
    Math.abs(sv.scrollX - bar.range / 2) < 1,
    `half the travel is half the range, got ${sv.scrollX}`,
  );
  wnd.emit('mouseup', { x: 0, y: 0, keycode: 1 });

  await x11Root.unmount();
});

test('a sideways scroll moves the content, not just the number', async () => {
  const { app, ref } = await mountWide();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);
  const firstCell = sv.children[0].children[0];
  const before = firstCell.abs.x;

  ref.current.scrollTo({ x: 150 });
  await tick();
  assert.strictEqual(
    firstCell.abs.x,
    before - 150,
    'children are laid out shifted by the scroll',
  );

  await x11Root.unmount();
});

test('scrollTo takes a number for y, or an object for either axis', async () => {
  const { app, ref } = await mountWide();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);

  ref.current.scrollTo(10); // the shape that existed before
  await tick();
  assert.strictEqual(sv.scrollY, 0, 'nothing to scroll vertically here');
  ref.current.scrollTo({ x: 1000 });
  await tick();
  assert.strictEqual(sv.scrollX, 400, 'clamped to the range');
  ref.current.scrollBy({ x: -50 });
  await tick();
  assert.strictEqual(sv.scrollX, 350);

  await x11Root.unmount();
});

test('the horizontal wheel scrolls sideways, and Shift+wheel does too', async () => {
  const { app, wnd } = await mountWide();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);

  // X button 7 is a wheel-right
  wnd.emit('mousedown', { x: 50, y: 50, keycode: 7 });
  await tick();
  assert.ok(sv.scrollX > 0, `wheel-right scrolled to ${sv.scrollX}`);

  const after = sv.scrollX;
  // Shift + wheel-down, for mice with no horizontal wheel (buttons bit 1)
  wnd.emit('mousedown', { x: 50, y: 50, keycode: 5, buttons: 1 });
  await tick();
  assert.ok(sv.scrollX > after, 'Shift turned a vertical wheel sideways');
  assert.strictEqual(sv.scrollY, 0, 'and did not scroll down as well');

  await x11Root.unmount();
});

test('scrollIntoView brings a node in from either side', async () => {
  const { app, ref } = await mountWide();
  const x11Root = await createRoot({ app });
  await tick();
  const sv = scroller(app);
  const last = sv.children[0].children[5];

  ref.current.scrollIntoView(last);
  await tick();
  assert.strictEqual(sv.scrollX, 400, 'scrolled right the minimum amount');

  ref.current.scrollIntoView(sv.children[0].children[0]);
  await tick();
  assert.strictEqual(sv.scrollX, 0, 'and back left again');

  await x11Root.unmount();
});

test('with both bars showing, neither runs into the other corner', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'scrollview',
        { style: { flexGrow: 1 } },
        ...Array.from({ length: 5 }, (_, i) =>
          h('box', {
            key: i,
            style: { width: 400, height: 40, flexShrink: 0 },
          }),
        ),
      ),
    ),
  );
  await tick();
  const sv = scroller(app);

  const vertical = sv._scrollbar('y');
  const horizontal = sv._scrollbar('x');
  assert.ok(vertical && horizontal, 'both axes overflow');
  assert.ok(
    vertical.trackLength < sv.abs.height,
    'the vertical track stops short of the corner',
  );
  assert.ok(
    horizontal.trackLength < sv.abs.width,
    'and so does the horizontal one',
  );

  await x11Root.unmount();
});
