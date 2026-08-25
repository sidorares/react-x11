// What a pure scroll frame is allowed to cost (issue #405).
//
// A frame whose only change is a viewport's offset moves every descendant by
// one constant and changes nothing else — so it must not re-measure the
// content reach, and it must not re-derive every descendant's rect from
// yoga. What is tested here is the seam that skipping those walks exposes:
// the cached measurement coming back fresh when something inside really
// changes (through layout, or through an element announcing pixels yoga
// never saw), and the shifted rects landing exactly where the full walk
// would have put them — for hit testing, for RTL, for nested panes scrolled
// in the same frame, and for a pane whose own box was moved from outside.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(children, windowProps = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h('window', { width: 200, height: 100, ...windowProps }, children),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.flushFrame?.();
  await tick();
  return { app, wnd, node: wnd._reactX11Node, x11Root };
}

const flush = async (wnd) => {
  wnd.flushFrame?.();
  await tick();
};

const rows = (n = 10, height = 40) =>
  Array.from({ length: n }, (_, i) =>
    h('box', { key: i, style: { height, flexShrink: 0 } }),
  );

/** Count calls without changing answers. */
function countMeasures(node) {
  const counter = { calls: 0 };
  const real = node.measureScrollContent.bind(node);
  node.measureScrollContent = (...args) => {
    counter.calls++;
    return real(...args);
  };
  return counter;
}

test('a pure scroll reuses the measured content reach', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(
    h('box', { ref, style: { overflow: 'scroll', flexGrow: 1 } }, ...rows()),
  );
  const box = ref.current;
  const measures = countMeasures(box);

  box.scrollTo(50);
  await flush(wnd);
  box.scrollTo(120);
  await flush(wnd);
  assert.equal(measures.calls, 0, 'scrolling re-derives nothing');
  // ...and the cached numbers still drive the clamp
  box.scrollTo(9999);
  await flush(wnd);
  assert.equal(box.scrollY, 300, 'clamped against the cached extent');
});

test('layout inside the pane re-measures; layout outside does not', async () => {
  const ref = React.createRef();
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = (rowHeight, sidebarWidth) =>
    x11Root.render(
      h(
        'window',
        { width: 200, height: 100, style: { flexDirection: 'row' } },
        h('box', { style: { width: sidebarWidth, flexShrink: 0 } }),
        h(
          'box',
          { ref, style: { overflow: 'scroll', flexGrow: 1 } },
          ...rows(10, rowHeight),
        ),
      ),
    );
  render(40, 20);
  await tick();
  const wnd = app.windows[0];
  await flush(wnd);
  const box = ref.current;
  box.scrollTo(50);
  await flush(wnd);
  const measures = countMeasures(box);

  // the sidebar widening is a real layout pass, but everything it moves is
  // outside the pane; the pane's own box shifts rigidly and the rows follow
  render(40, 30);
  await tick();
  await flush(wnd);
  assert.equal(box.abs.x, 30, 'the pane itself moved');
  assert.equal(box.children[0].abs.x, 30, 'rows moved with it');
  assert.equal(box.children[2].abs.y, 80 - 50, 'still scrolled by 50');

  // a row growing is layout inside: the reach must be re-learned
  render(50, 30);
  await tick();
  await flush(wnd);
  assert.ok(measures.calls >= 1, 're-measured after an inside reflow');
  assert.equal(box.contentHeight, 500, 'and the new reach is the truth');
});

test('a pure scroll lands every child where the full walk would', async () => {
  const ref = React.createRef();
  const { wnd, node } = await mount(
    h('box', { ref, style: { overflow: 'scroll', flexGrow: 1 } }, ...rows()),
  );
  const box = ref.current;
  // populated *before* the scroll, so what the second hit test reads is the
  // cached bounds as the shift left them, not a cache built fresh after it
  assert.ok(node.hitTest(100, 25) === box.children[0], 'row 0 before');
  box.scrollTo(70);
  await flush(wnd);
  for (let i = 0; i < box.children.length; i++) {
    assert.equal(box.children[i].abs.y, i * 40 - 70, `row ${i}`);
  }
  // 25 from the top was inside row 0; scrolled by 70 it is inside row 2
  assert.ok(node.hitTest(100, 25) === box.children[2], 'row 2 after');
});

test('a sideways pure scroll under RTL shifts the other way', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(
    h(
      'box',
      {
        ref,
        style: {
          overflow: 'scroll',
          flexGrow: 1,
          flexDirection: 'row',
          direction: 'rtl',
        },
      },
      ...Array.from({ length: 5 }, (_, i) =>
        h('box', { key: i, style: { width: 100, flexShrink: 0 } }),
      ),
    ),
  );
  const box = ref.current;
  const first = box.children[0].abs.x;
  box.scrollTo({ x: 60 });
  await flush(wnd);
  // scrollX is a distance from the start edge — the right-hand one here —
  // so the content moves right, exactly as the full walk moves it
  assert.equal(box.children[0].abs.x, first + 60);
});

test('a nested pane wheeled in the same frame still lands', async () => {
  const outer = React.createRef();
  const inner = React.createRef();
  const { wnd } = await mount(
    h(
      'box',
      { ref: outer, style: { overflow: 'scroll', flexGrow: 1 } },
      h('box', { style: { height: 30, flexShrink: 0 } }),
      h(
        'box',
        {
          ref: inner,
          style: { height: 60, flexShrink: 0, overflow: 'scroll' },
        },
        ...rows(8, 20),
      ),
      ...rows(6, 40),
    ),
  );
  await flush(wnd);
  // both offsets change before one frame runs: the outer pane's shift and
  // the inner pane's own scroll must fold into one move for the inner rows
  outer.current.scrollTo(25);
  inner.current.scrollTo(40);
  await flush(wnd);
  const innerTop = inner.current.abs.y;
  assert.equal(innerTop, 30 - 25, 'the inner pane rode the outer scroll');
  assert.equal(
    inner.current.children[0].abs.y,
    innerTop - 40,
    "…and its rows carry the inner pane's own offset too",
  );
});

test('painted content re-arms the measurement by invalidating', async () => {
  const ref = React.createRef();
  const { wnd } = await mount(
    h('box', { ref, style: { overflow: 'scroll', flexGrow: 1 } }),
  );
  const box = ref.current;
  // an element whose content is pixels rather than children answers the
  // reach itself (docs/extending.md) — stand in for one on a live node
  let lines = 20;
  box.measureScrollContent = () => ({ width: 0, height: lines * 16 });
  // the measurement above has never been asked: any layout change asks it
  box.invalidate(true, box, 'scroll');
  await flush(wnd);
  assert.equal(box._maxScroll('y'), 20 * 16 - 100);

  box.scrollTo(50);
  await flush(wnd);

  // rows arrive; the documented announcement is what re-asks the question
  lines = 40;
  box.invalidate(true, box, 'scroll');
  await flush(wnd);
  assert.equal(box._maxScroll('y'), 40 * 16 - 100, 'the extent grew');
});
