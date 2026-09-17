// `Slider`'s style slots (#593): `thumbStyle`, `trackStyle` and `fillStyle`,
// each merged over the part's own default.
//
// A designed slider — the flat one from the Hush port: a 3px track, a 14px
// thumb in the accent colour with no ring and a soft shadow — is the widget
// restyled, and keeps what the widget does: the pointer's travel, the
// keyboard, the target size. So besides the styles landing, what is pinned is
// that the thumb's own size is what the drag and the control's height are
// measured with, and that a styled slider is the drawn one even where the
// platform's bezel would otherwise be used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import { createRoot, Slider } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const FLAT = {
  thumbStyle: {
    width: 14,
    height: 14,
    backgroundColor: '#3b82f6',
    borderWidth: 0,
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
  },
  trackStyle: { height: 3, backgroundColor: '#dbeafe' },
  fillStyle: { backgroundColor: '#3b82f6' },
};

/** A slider 200 wide in a window, with its value in state. */
async function mount(props, { app = createMockApp() } = {}) {
  const seen = [];
  const Host = () => {
    const [value, setValue] = React.useState(props.value ?? 0);
    seen.push(value);
    return h(
      'window',
      { width: 400, height: 120 },
      h(
        'box',
        { style: { flexGrow: 1, padding: 20 } },
        h(Slider, {
          ...props,
          value,
          onChange: (ev) => setValue(ev.value),
          style: { width: 200 },
        }),
      ),
    );
  };
  const root = await createRoot({ app });
  root.render(h(Host));
  await tick();
  await tick();
  const wnd = app.windows[0];
  const control = (function find(n) {
    if (n.props?.role === 'slider') return n;
    for (const c of n.children) {
      if (c.isWindow) continue;
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  })(wnd._reactX11Node);
  const [track, thumb] = [
    control.children.find((c) => c.style.position !== 'absolute'),
    control.children.find((c) => c.style.position === 'absolute'),
  ];
  return { app, root, wnd, control, track, thumb, seen };
}

test('the slots reach the parts they name, over the defaults', async () => {
  const m = await mount(FLAT);
  assert.equal(m.thumb.style.backgroundColor, '#3b82f6');
  assert.equal(m.thumb.style.borderWidth ?? 0, 0, 'no ring');
  assert.ok(m.thumb.style.boxShadow, 'the shadow');
  assert.deepEqual([m.thumb.abs.width, m.thumb.abs.height], [14, 14]);
  assert.equal(m.track.abs.height, 3);
  assert.equal(m.track.style.backgroundColor, '#dbeafe');
  const fill = m.track.children[0];
  assert.equal(fill.style.backgroundColor, '#3b82f6');
  assert.equal(fill.abs.height, 3, 'the fill is as thick as its track');
  // a round thumb by default still, from its own size
  assert.equal(m.thumb.style.borderRadius, 7);
  await m.root.unmount();
});

test('the control is as tall as its thumb, and its target still reaches 24', async () => {
  const m = await mount(FLAT);
  assert.equal(m.control.abs.height, 14);
  assert.deepEqual(m.control.style.hitSlop, { top: 5, bottom: 5 });
  await m.root.unmount();

  const wide = await mount({ thumbStyle: { width: 24 } });
  assert.deepEqual(
    [wide.thumb.abs.width, wide.thumb.abs.height, wide.control.abs.height],
    [24, 24, 24],
    'a width alone is a circle that size',
  );
  await wide.root.unmount();

  const tall = await mount({ trackStyle: { height: 30 } });
  assert.equal(tall.control.abs.height, 30, 'a track taller than the thumb');
  assert.deepEqual(tall.control.style.hitSlop, { top: 0, bottom: 0 });
  await tall.root.unmount();
});

test("the pointer's travel is the track less the thumb it was given", async () => {
  const m = await mount({ thumbStyle: { width: 40, height: 20 } });
  const { x, y, width, height } = m.control.abs;
  const cy = y + height / 2;
  const THUMB = 40;
  const at = (f) => x + THUMB / 2 + (width - THUMB) * f;
  m.wnd.emit('mousedown', { x: at(0.5), y: cy, keycode: 1 });
  await tick();
  assert.equal(m.seen.at(-1), 50, 'the middle of the travel');
  m.wnd.emit('mousemove', { x: at(0.25), y: cy });
  await tick();
  await tick();
  assert.equal(m.seen.at(-1), 25);
  m.wnd.emit('mouseup', { x: at(0.25), y: cy, keycode: 1 });
  await tick();
  await m.root.unmount();
});

test('a big thumb stays on its track at both ends', async () => {
  for (const value of [0, 100]) {
    const m = await mount({ value, thumbStyle: { width: 40, height: 20 } });
    assert.ok(m.thumb.abs.x >= m.control.abs.x - 0.5, `${value}: left edge`);
    assert.ok(
      m.thumb.abs.x + m.thumb.abs.width <=
        m.control.abs.x + m.control.abs.width + 0.5,
      `${value}: right edge`,
    );
    await m.root.unmount();
  }
});

test('with no slots it is the slider it was', async () => {
  const m = await mount({});
  assert.deepEqual([m.thumb.abs.width, m.thumb.abs.height], [16, 16]);
  assert.equal(m.thumb.style.borderWidth, 1, 'the ring');
  assert.equal(m.track.abs.height, 4);
  assert.equal(m.control.abs.height, 16);
  assert.deepEqual(m.control.style.hitSlop, { top: 4, bottom: 4 });
  await m.root.unmount();
});

test("a styled slider is the drawn one, where the platform's bezel would be used", async () => {
  const bezelled = () => {
    const app = createMockApp();
    app.nativeBezels = {
      natural: () => ({ width: 60, height: 15 }),
      shadow: () => ({ top: 0, bottom: 0 }),
      get: () => ({ surface: {}, sx: 0, sy: 0, sw: 1, sh: 1 }),
    };
    return app;
  };
  const canvases = (control) =>
    control.children.filter((c) => c.kind === 'canvas').length;

  const plain = await mount({}, { app: bezelled() });
  assert.equal(canvases(plain.control), 1, 'the control: a bezel');
  await plain.root.unmount();

  const styled = await mount(
    { trackStyle: { height: 3 } },
    { app: bezelled() },
  );
  assert.equal(canvases(styled.control), 0, 'no bezel under a style');
  assert.equal(styled.track.abs.height, 3);
  await styled.root.unmount();
});
