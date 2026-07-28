// Dragging the scrollbar with the pointer: the thumb follows the pointer,
// the track pages, and the bar belongs to the scroller rather than to the
// content painted under it.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import ReactX11 from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 10 rows of 40 in a 100-tall viewport: 400 of content, 300 of scroll range
function mount() {
  const app = createMockApp();
  const ref = React.createRef();
  ReactX11.render(
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
    null,
    app,
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
  const { app, wnd } = mount();
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();
  assert.ok(bar, 'the bar shows when the content overflows');
  assert.strictEqual(sv.scrollY, 0);

  // grab the middle of the thumb and take it half way down the travel
  wnd.emit('mousedown', {
    x: bar.x + 2,
    y: bar.thumbY + bar.thumbHeight / 2,
    keycode: 1,
  });
  wnd.emit('mousemove', {
    x: bar.x + 2,
    y: bar.thumbY + bar.thumbHeight / 2 + bar.travel / 2,
  });
  assert.ok(
    Math.abs(sv.scrollY - bar.range / 2) < 1,
    `half the travel should be half the range, got ${sv.scrollY}`,
  );

  // and past the end clamps rather than overscrolling
  wnd.emit('mousemove', { x: bar.x + 2, y: 10_000 });
  assert.strictEqual(sv.scrollY, bar.range);

  wnd.emit('mouseup', { x: bar.x + 2, y: 10_000, keycode: 1 });
  ReactX11.unmountComponentAtNode(app);
});

test('the drag keeps its grip on the thumb, without jumping', async () => {
  const { app, wnd } = mount();
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();

  // press near the *bottom* of the thumb and do not move: nothing should
  // happen — a jump-to-pointer implementation would scroll here
  wnd.emit('mousedown', {
    x: bar.x + 2,
    y: bar.thumbY + bar.thumbHeight - 1,
    keycode: 1,
  });
  assert.strictEqual(sv.scrollY, 0, 'grabbing the thumb does not move it');
  wnd.emit('mouseup', { x: bar.x + 2, y: bar.thumbY, keycode: 1 });

  ReactX11.unmountComponentAtNode(app);
});

test('a press on the track pages towards the pointer', async () => {
  const { app, wnd } = mount();
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();

  wnd.emit('mousedown', {
    x: bar.x + 2,
    y: bar.trackY + bar.trackHeight - 2,
    keycode: 1,
  });
  assert.strictEqual(sv.scrollY, 100, 'one viewport down');
  wnd.emit('mouseup', { x: bar.x + 2, y: bar.trackY, keycode: 1 });

  wnd.emit('mousedown', { x: bar.x + 2, y: bar.trackY + 1, keycode: 1 });
  assert.strictEqual(sv.scrollY, 0, 'and back up again');

  ReactX11.unmountComponentAtNode(app);
});

test('the bar takes the press even with content painted under it', async () => {
  const app = createMockApp();
  const clicks = [];
  ReactX11.render(
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
    null,
    app,
  );
  await tick();
  const sv = scroller(app);
  const bar = sv._scrollbar();

  drag(
    app.windows[0],
    { x: bar.x + 2, y: bar.thumbY + 2 },
    { x: bar.x + 2, y: bar.thumbY + 2 },
  );
  assert.deepStrictEqual(clicks, [], 'the row under the bar was not clicked');

  // a press just inside the content does still reach the row
  drag(app.windows[0], { x: 10, y: 10 }, { x: 10, y: 10 });
  assert.deepStrictEqual(clicks, [0]);

  ReactX11.unmountComponentAtNode(app);
});

test('a <textarea> bar drag scrolls it, and never moves the caret', async () => {
  const app = createMockApp();
  ReactX11.render(
    h(
      'window',
      { width: 200, height: 80 },
      h('textarea', { value: 'many lines', style: { flexGrow: 1 } }),
    ),
    null,
    app,
  );
  await tick();

  const area = app.windows[0]._reactX11Node.children[0];
  // the mock has no font metrics, so stand in for the laid-out text: all
  // the bar needs from it is a height
  area._valueLayout = () => ({ height: 600 });

  const bar = area._scrollbar();
  assert.ok(bar, 'text taller than the box gets a thumb');
  const caretBefore = area._caret;

  area._defaultMouseDown({
    x: bar.x + 2,
    y: bar.thumbY + 2,
    capturePointer() {},
  });
  area._defaultMouseDrag({ x: bar.x + 2, y: bar.thumbY + 2 + bar.travel / 2 });
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

  ReactX11.unmountComponentAtNode(app);
});
