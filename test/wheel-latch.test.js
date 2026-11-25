// The wheel chain is per axis, from where each pane is, and a gesture keeps
// the pane it started on. A pane that scrolls both ways, in a page that
// scrolls down, used to take every notch while the pointer was over it —
// at its bottom too, where it swallowed the page's scroll — and a touchpad's
// stray sideways fraction moved it sideways as well.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, flushFrames, spinWheel } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount() {
  const app = createMockApp();
  const root = await createRoot({ app });
  const page = React.createRef();
  const inner = React.createRef();
  const fixed = (style) => ({ style: { flexShrink: 0, ...style } });
  root.render(
    h(
      'window',
      { width: 400, height: 300 },
      h(
        'box',
        { ref: page, style: { width: 400, height: 300, overflow: 'scroll' } },
        h('box', fixed({ height: 100 })),
        h(
          'box',
          {
            ref: inner,
            ...fixed({ width: 380, height: 150, overflow: 'scroll' }),
          },
          h('box', fixed({ width: 900, height: 500 })),
        ),
        h('box', fixed({ height: 800 })),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  flushFrames(wnd);
  await tick();
  return { wnd, page: page.current, inner: inner.current };
}

let clock = 1_000_000;
const realNow = Date.now;
Date.now = () => clock;
test.after(() => {
  Date.now = realNow;
});
const quiet = () => (clock += 1000);
async function wheel(wnd, opts) {
  clock += 10;
  spinWheel(wnd, 150, 175, opts);
  flushFrames(wnd);
  await tick();
}

test('a pane at the end of its extent lets a new gesture through to the page', async () => {
  const { wnd, page, inner } = await mount();
  for (let i = 0; i < 10; i++) await wheel(wnd, { deltaY: 1 });
  assert.strictEqual(
    inner.scrollY,
    350,
    'the pane took the gesture to its end',
  );
  assert.strictEqual(page.scrollY, 0, 'and the latch kept the page out of it');
  quiet();
  await wheel(wnd, { deltaY: 1 });
  assert.strictEqual(inner.scrollY, 350);
  assert.strictEqual(page.scrollY, 48, 'a new gesture goes on to the page');
});

test('a gesture on the page stays on it as a pane passes under the pointer', async () => {
  const { wnd, page, inner } = await mount();
  // the pointer starts above the pane: only the page is there
  clock += 10;
  spinWheel(wnd, 150, 40, { deltaY: 1 });
  flushFrames(wnd);
  await tick();
  assert.strictEqual(page.scrollY, 48);
  for (let i = 0; i < 4; i++) await wheel(wnd, { deltaY: 1 });
  assert.strictEqual(inner.scrollY, 0, 'the pane that arrived did not take it');
  assert.ok(page.scrollY > 48);
});

test('a stray sideways fraction does not move a pane scrolled down', async () => {
  const { wnd, inner } = await mount();
  await wheel(wnd, { deltaY: 1, deltaX: 0.1, smooth: true });
  await wheel(wnd, { deltaY: 1, deltaX: 0.1, smooth: true });
  assert.ok(inner.scrollY > 0);
  assert.strictEqual(inner.scrollX, 0);
});

test('a diagonal gesture moves both axes', async () => {
  const { wnd, inner } = await mount();
  await wheel(wnd, { deltaY: 1, deltaX: 1 });
  assert.ok(inner.scrollX > 0 && inner.scrollY > 0);
});
