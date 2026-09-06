// `onLayout` on any drawn element: the rect a layout pass gave it, reported
// after the first layout and then when it changes — React Native's contract,
// and the React-side seam beside the container queries (docs/styling.md).
import { test } from 'node:test';
import assert from 'node:assert';
import React, { useState } from 'react';
import { createRoot } from '../src/index.js';
import { createStyles } from '../src/styles.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
// the layout pass runs on one tick and the report is deferred past it
const settle = async () => {
  await tick();
  await tick();
  await tick();
};
const nodeOf = (app) => app.windows[0]._reactX11Node;

async function resize(app, width, height = 300) {
  const wnd = app.windows[0];
  wnd.width = width;
  wnd.height = height;
  wnd.emit('resize', { width, height });
  await settle();
}

test('reports the rect after the first layout, then only when it changes', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const calls = [];
  const render = (handler) =>
    x11Root.render(
      h(
        'window',
        { width: 400, height: 300 },
        h(
          'box',
          { style: { padding: 10, flexGrow: 1 } },
          h('box', {
            style: { height: 40, ':hover': { backgroundColor: 'red' } },
            focusable: true,
            onLayout: handler,
          }),
        ),
      ),
    );
  render((ev) => calls.push(ev));
  await settle();
  assert.deepStrictEqual(
    calls,
    [{ x: 10, y: 10, width: 380, height: 40 }],
    'once, with the rect the pass produced: inside the padding, the full width',
  );

  // a repaint-only change says nothing
  const box = nodeOf(app).children[0].children[0];
  box.setStyleState(':hover', true);
  await settle();
  assert.strictEqual(calls.length, 1, 'hover is a repaint, not a layout');

  // nor does a render that hands over a new handler for the same layout
  render((ev) => calls.push(ev));
  await settle();
  assert.strictEqual(calls.length, 1, 'a fresh inline arrow is not a change');

  // the window narrows, so the box does
  await resize(app, 300);
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls[1], { x: 10, y: 10, width: 280, height: 40 });
  await x11Root.unmount();
});

test('a scroll moves the element on screen but not in its layout, so it does not fire', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const calls = [];
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        h('box', { key: 'a', style: { height: 80 } }),
        h('box', {
          key: 'b',
          style: { height: 80 },
          onLayout: (ev) => calls.push(ev),
        }),
      ),
    ),
  );
  await settle();
  const scroller = nodeOf(app).children[0];
  const b = scroller.children[1];
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    x: 0,
    y: 80,
    width: b.abs.width,
    height: 80,
  });
  const before = b.abs.y;
  scroller.scrollTo({ y: 30 });
  await settle();
  assert.strictEqual(b.abs.y, before - 30, 'the pane did scroll');
  assert.strictEqual(calls.length, 1, 'and the row said nothing');
  await x11Root.unmount();
});

test("in the element's own logical pixels, under a scale", async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const calls = [];
  x11Root.render(
    h(
      'window',
      { width: 400, height: 300 },
      h(
        'box',
        { scale: 2, style: { padding: 5 } },
        h('box', {
          style: { width: 50, height: 20 },
          onLayout: (ev) => calls.push(ev),
        }),
      ),
    ),
  );
  await settle();
  const inner = nodeOf(app).children[0].children[0];
  assert.strictEqual(inner.abs.width, 100, '50 logical is 100 device pixels');
  assert.deepStrictEqual(calls, [{ x: 5, y: 5, width: 50, height: 20 }]);
  await x11Root.unmount();
});

test('state set from the handler re-renders once and does not loop', async () => {
  let reports = 0;
  function Columns() {
    const [cols, setCols] = useState(1);
    return h(
      'box',
      {
        style: { flexGrow: 1, flexDirection: 'row' },
        onLayout: (ev) => {
          reports += 1;
          setCols(Math.max(1, Math.floor(ev.width / 100)));
        },
      },
      ...Array.from({ length: cols }, (_, i) =>
        h('box', { key: i, style: { flexGrow: 1, height: 10 } }),
      ),
    );
  }
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 350, height: 300 }, h(Columns)));
  await settle();
  await settle();
  const row = nodeOf(app).children[0];
  assert.strictEqual(row.children.length, 3, 'three columns fit in 350');
  assert.strictEqual(
    reports,
    1,
    'the re-render changed the children, not the row',
  );
  await resize(app, 550);
  await settle();
  assert.strictEqual(row.children.length, 5);
  assert.strictEqual(reports, 2);
  await x11Root.unmount();
});

test('reports the rect the container blocks settled on, once', async () => {
  // the card is 50 tall until its container is known to be wide, which the
  // first layout pass is what establishes — the report carries the height
  // the frame ended at, not the one between the passes
  const s = createStyles({
    pane: { container: true, width: 500 },
    card: { height: 50, '@container width >= 400': { height: 100 } },
  });
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const calls = [];
  x11Root.render(
    h(
      'window',
      { width: 800, height: 300 },
      h(
        'box',
        { style: s.pane },
        h('box', { style: s.card, onLayout: (ev) => calls.push(ev) }),
      ),
    ),
  );
  await settle();
  assert.deepStrictEqual(calls, [{ x: 0, y: 0, width: 500, height: 100 }]);
  await x11Root.unmount();
});
