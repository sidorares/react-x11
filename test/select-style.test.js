// `Select`'s style slots: `labelStyle` and `chevronStyle`, each merged over
// the part's own default, as `Slider`'s are over its parts.
//
// A select that has to wear somebody else's look — a toolbar's, or a web
// page's in `@react-x11/components`' `<Html>`, where a `<select>` the page
// gave a background of its own is drawn by the document and the widget is
// mounted bare inside it — needs its caption in that look's colour and face,
// and its chevron to match or to go. `style` already reached the trigger's
// box; nothing reached the caption, which named the palette's `text` itself,
// or the chevron, which named `textMuted` at the palette's cap height. So
// besides the styles landing, what is pinned is that the chevron is sized
// against the caption it stands beside, and that a styled select is the
// drawn one even where the platform's popup bezel would otherwise be used.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import { createRoot, Select } from '../src/index.js';
import { capBand, DefaultTheme } from '../src/components/theme.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const OPTIONS = [
  { value: 'a', label: 'Default' },
  { value: 'b', label: 'Retro' },
];

/** A select 200 wide in a window. */
async function mount(props, { app = createMockApp() } = {}) {
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 400, height: 120 },
      h(
        'box',
        { style: { flexGrow: 1, padding: 20, alignItems: 'flex-start' } },
        h(Select, {
          value: 'a',
          options: OPTIONS,
          ...props,
          style: [{ width: 200 }, props.style],
        }),
      ),
    ),
  );
  await tick();
  await tick();
  const wnd = app.windows[0];
  const find = (n, test) => {
    if (test(n)) return n;
    for (const c of n.children) {
      if (c.isWindow) continue;
      const hit = find(c, test);
      if (hit) return hit;
    }
    return null;
  };
  const trigger = find(wnd._reactX11Node, (n) => n.props?.role === 'combobox');
  const caption = trigger.children.find((c) => c.kind === 'text');
  const chevron = find(trigger, (n) => n.props?.cacheKey === 'chevronDown');
  return { root, trigger, caption, chevron };
}

test('the slots reach the parts they name, over the defaults', async () => {
  const m = await mount({
    labelStyle: { color: '#222222', fontWeight: 'bold' },
    chevronStyle: { color: '#ff0000' },
  });
  assert.equal(m.caption.style.color, '#222222');
  assert.equal(m.caption.style.fontWeight, 'bold');
  assert.equal(m.caption.style.textWrap, 'nowrap', 'still one line');
  assert.equal(m.chevron.style.color, '#ff0000');
  await m.root.unmount();
});

test('the chevron is as tall as the capitals of the caption it was given', async () => {
  const m = await mount({ labelStyle: { fontSize: 28 } });
  assert.deepEqual(
    [m.chevron.abs.width, m.chevron.abs.height],
    [capBand(28), capBand(28)],
  );
  await m.root.unmount();
});

test("`display: 'none'` leaves the chevron out", async () => {
  const m = await mount({ chevronStyle: { display: 'none' } });
  assert.equal(m.chevron.style.display, 'none');
  assert.equal(m.chevron.abs.width, 0, 'no room kept for it');
  await m.root.unmount();
});

test('the caller styles the box, the slots what is in it', async () => {
  // the bare trigger `<Html>` mounts in a page-styled select's content box
  const m = await mount({
    style: {
      paddingLeft: 0,
      paddingRight: 0,
      borderWidth: 0,
      ':hover': { backgroundColor: 'transparent' },
    },
    labelStyle: { color: '#222222', fontSize: 13 },
    chevronStyle: { color: '#222222' },
  });
  assert.equal(m.trigger.style.borderWidth, 0);
  assert.equal(
    m.chevron.abs.x + m.chevron.abs.width,
    m.trigger.abs.x + m.trigger.abs.width,
    'the chevron at the end of a trigger with no insets',
  );
  await m.root.unmount();
});

test('with no slots it is the select it was', async () => {
  const m = await mount({});
  assert.equal(m.caption.style.color, DefaultTheme.text);
  assert.equal(m.chevron.style.color, DefaultTheme.textMuted);
  assert.equal(m.chevron.abs.width, capBand(DefaultTheme.fontSize));
  await m.root.unmount();

  const empty = await mount({ value: undefined });
  assert.equal(empty.caption.style.color, DefaultTheme.textMuted);
  await empty.root.unmount();
});

test("a styled select is the drawn one, where the platform's bezel would be used", async () => {
  const bezelled = () => {
    const app = createMockApp();
    app.nativeBezels = {
      natural: () => ({ width: 60, height: 21 }),
      shadow: () => ({ top: 0, bottom: 0 }),
      get: () => ({ surface: {}, sx: 0, sy: 0, sw: 1, sh: 1 }),
    };
    return app;
  };

  const plain = await mount({}, { app: bezelled() });
  assert.equal(plain.chevron, null, "the bezel's own arrows");
  await plain.root.unmount();

  for (const slot of [
    { labelStyle: { color: '#222222' } },
    { chevronStyle: { color: '#222222' } },
  ]) {
    const styled = await mount(slot, { app: bezelled() });
    assert.ok(styled.chevron, `${Object.keys(slot)[0]}: the drawn chevron`);
    assert.equal(styled.trigger.style.borderWidth, DefaultTheme.borderWidth);
    await styled.root.unmount();
  }
});
