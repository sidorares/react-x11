// Issue #273: the scroll distance is the one the device measured.
//
// Every scroll used to be 48 pixels, because the only thing a core X client
// can see of a wheel is a press of button 4/5/6/7 — and a press carries no
// magnitude. ntk 7.5 reads the device's scroll valuators through XI2 where
// the server has it and falls back to those buttons where it does not, and
// reports either as a `wheel` event in notches. What is tested here is the
// renderer's half: that a notch becomes pixels once, that a fraction of one
// survives the trip, and that the emulated press behind a notch is not
// counted a second time.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 20 rows of 40 in a 200-tall window: 800 of content, 600 to scroll. */
const rows = (n = 20) =>
  Array.from({ length: n }, (_, i) =>
    h('box', { key: i, style: { height: 40, flexShrink: 0 } }),
  );

async function mount(children, windowProps = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200, ...windowProps },
      h('box', { style: { overflow: 'scroll', flexGrow: 1 } }, ...children),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.flushFrame?.();
  await tick();
  return {
    app,
    wnd,
    node: wnd._reactX11Node,
    pane: wnd._reactX11Node.children[0],
  };
}

// --- the distance -----------------------------------------------------------

test('a whole notch is the step an arrow key takes', async () => {
  const { wnd, pane } = await mount(rows());
  spinWheel(wnd, 100, 100, { deltaY: 1 });
  await tick();
  assert.strictEqual(pane.scrollY, 48, 'one notch, one step');
});

test('a fraction of a notch scrolls a fraction of the step', async () => {
  const { wnd, pane } = await mount(rows());
  // what a touchpad measures: a quarter of the distance the device calls a
  // notch. The emulated button behind it could only ever have said "one".
  spinWheel(wnd, 100, 100, { deltaY: 0.25, smooth: true });
  await tick();
  assert.strictEqual(pane.scrollY, 12);
});

test('sub-notch deltas add up instead of rounding away', async () => {
  const { wnd, pane } = await mount(rows());
  for (let i = 0; i < 8; i++) {
    spinWheel(wnd, 100, 100, { deltaY: 0.125, smooth: true });
  }
  await tick();
  assert.strictEqual(pane.scrollY, 48, 'eight eighths are a notch');
});

test('the offset stays a whole number, and the fraction is not lost', async () => {
  const { wnd, pane } = await mount(rows());
  // 0.3 of a notch is 14.4 pixels: the scroll blit can only shift whole
  // ones, so the offset takes 14 and the renderer owes 0.4 — three of them
  // are 43.2 pixels asked for and 43 delivered, not 42.
  for (let i = 0; i < 3; i++) {
    spinWheel(wnd, 100, 100, { deltaY: 0.3, smooth: true });
    await tick();
    assert.ok(
      Number.isInteger(pane.scrollY),
      `offset ${pane.scrollY} is a whole pixel`,
    );
  }
  assert.strictEqual(pane.scrollY, 43);
});

test('a scroll too small to move a pixel still moves one eventually', async () => {
  const { wnd, pane } = await mount(rows());
  // a fiftieth of a notch is under a pixel; ten of them are not
  for (let i = 0; i < 9; i++) {
    spinWheel(wnd, 100, 100, { deltaY: 0.02, smooth: true });
  }
  await tick();
  assert.strictEqual(
    pane.scrollY,
    8,
    'the change adds up rather than dropping',
  );
});

test('a scroll up is negative, and clamps at the top like any other', async () => {
  const { wnd, pane } = await mount(rows());
  spinWheel(wnd, 100, 100, { deltaY: 4 });
  await tick();
  assert.strictEqual(pane.scrollY, 192);

  spinWheel(wnd, 100, 100, { deltaY: -1.5, smooth: true });
  await tick();
  assert.strictEqual(pane.scrollY, 120, 'a notch and a half back up');
});

// --- what the handler sees --------------------------------------------------

test('deltas reach a handler in pixels, with the device behind them named', async () => {
  const seen = [];
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200, onWheel: (ev) => seen.push(ev) },
      h('box', { style: { overflow: 'scroll', flexGrow: 1 } }, ...rows()),
    ),
  );
  await tick();
  const wnd = app.windows[0];

  spinWheel(wnd, 100, 100, { deltaY: 0.5, smooth: true });
  spinWheel(wnd, 100, 100, { deltaY: 1 });
  await tick();

  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].deltaY, 24, 'half a notch of 48');
  assert.strictEqual(seen[0].deltaX, 0);
  assert.strictEqual(
    seen[0].smooth,
    true,
    'a device that can measure a fraction says so',
  );
  assert.strictEqual(seen[1].deltaY, 48);
  assert.strictEqual(
    seen[1].smooth,
    false,
    'and the emulated button admits it cannot',
  );

  await x11Root.unmount();
});

test('preventDefault still stops the scroll it would have done', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200, onWheel: (ev) => ev.preventDefault() },
      h('box', { style: { overflow: 'scroll', flexGrow: 1 } }, ...rows()),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const pane = wnd._reactX11Node.children[0];

  spinWheel(wnd, 100, 100, { deltaY: 0.75, smooth: true });
  await tick();
  assert.strictEqual(pane.scrollY, 0);

  await x11Root.unmount();
});

// --- the press behind the notch ---------------------------------------------

test('the emulated wheel button scrolls nothing on its own', async () => {
  const presses = [];
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200, onMouseDown: (ev) => presses.push(ev) },
      h('box', { style: { overflow: 'scroll', flexGrow: 1 } }, ...rows()),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const pane = wnd._reactX11Node.children[0];

  // A core connection sends both halves of the same notch: ntk's `wheel`,
  // and the button press it was derived from. Counting the press too would
  // scroll twice as far as the user asked for.
  spinWheel(wnd, 100, 100, { deltaY: 1 });
  for (const keycode of [4, 5, 6, 7]) {
    wnd.emit('mousedown', { x: 100, y: 100, keycode });
    wnd.emit('mouseup', { x: 100, y: 100, keycode });
  }
  await tick();

  assert.strictEqual(pane.scrollY, 48, 'the notch, once');
  assert.deepStrictEqual(presses, [], 'and no mouseDown for a wheel button');

  await x11Root.unmount();
});

// --- the axis ---------------------------------------------------------------

test('Shift turns a one-axis wheel sideways, whatever measured it', async () => {
  const { wnd, pane } = await mount(
    [
      h('box', {
        key: 'wide',
        style: { width: 800, height: 40, flexShrink: 0 },
      }),
    ],
    {},
  );
  // buttons bit 0 is Shift in the X modifier mask
  spinWheel(wnd, 100, 100, { deltaY: 1, buttons: 1 });
  await tick();
  assert.strictEqual(pane.scrollX, 48, 'the vertical notch went sideways');
  assert.strictEqual(pane.scrollY, 0);

  // …and a touchpad, which has an axis of its own, keeps the one it reported
  spinWheel(wnd, 100, 100, {
    deltaX: 0.5,
    deltaY: 0.25,
    smooth: true,
    buttons: 1,
  });
  await tick();
  assert.strictEqual(pane.scrollX, 72, 'half a notch right, as reported');
});

// --- selecting it -----------------------------------------------------------

test('a window asks for XI2; a popup, which grabs, does not', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h('popup', { width: 80, height: 40, x: 10, y: 10 }),
    ),
  );
  await tick();

  const [window, popup] = app.windows;
  assert.strictEqual(
    window.attributes.xi2,
    true,
    'the window scrolls smoothly',
  );
  assert.strictEqual(
    popup.attributes.xi2,
    false,
    'a grabbing menu stays on the wheel buttons the grab delivers',
  );

  await x11Root.unmount();
});

test('a window can turn it down', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 200, xi2: false }));
  await tick();
  assert.strictEqual(app.windows[0].attributes.xi2, false);
  await x11Root.unmount();
});
