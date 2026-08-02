// The press state: what a control shows between the button going down and
// the click that only happens when it comes back up.
//
// `onPress`/`onChange` fire on the *release*, so for as long as a user holds
// a button — half a second, without noticing they did — the whole of the
// feedback is `:active`. Two things have to be true for that to work at all:
// it has to reach the control rather than the `<text>` inside it that the
// pointer actually hit, and it has to mean "releasing now activates this",
// so that it agrees with the click the release will or will not synthesize.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  Button,
  Checkbox,
  Select,
  Switch,
  Tabs,
  createRoot,
} from '../src/index.js';
import { resolveTheme } from '../src/components/theme.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const rootOf = (app) => app.windows[0]._reactX11Node;

const find = (node, pred) =>
  pred(node)
    ? node
    : node.children.reduce(
        (a, c) => a || (c.isWindow ? null : find(c, pred)),
        null,
      );

const textNode = (node, label) =>
  find(node, (n) => n.kind === 'text' && String(n.props.children) === label);

const centre = (node) => ({
  x: node.abs.x + node.abs.width / 2,
  y: node.abs.y + node.abs.height / 2,
});

const down = (wnd, node) =>
  wnd.emit('mousedown', { ...centre(node), keycode: 1 });
const up = (wnd, node) => wnd.emit('mouseup', { ...centre(node), keycode: 1 });
const moveTo = (wnd, node) => wnd.emit('mousemove', centre(node));

async function mount(element, width = 300, height = 200) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width, height }, element));
  await settle();
  return { app, x11Root, wnd: app.windows[0], tree: rootOf(app) };
}

// --- the press chain ----------------------------------------------------

test('a press marks the whole chain, not the node it landed on', async () => {
  // What a control is actually built out of: the pointer lands on the inner
  // node, and the outer one is the control that has to answer. A `<Button>`
  // is exactly this shape — its label is the hit target — but text measures
  // 0x0 against the mock, which has no fonts, so the shape is written out.
  const { x11Root, wnd, tree } = await mount(
    h(
      'box',
      { style: { width: 120, height: 60, padding: 10 }, focusable: true },
      h('box', { style: { width: 40, height: 40 } }),
    ),
  );
  const control = tree.children[0];
  const inner = control.children[0];

  wnd.emit('mousedown', { ...centre(inner), keycode: 1 });
  assert.ok(inner.states[':active'], 'the node the pointer hit is pressed');
  assert.ok(
    control.states[':active'],
    'and so is the control it is inside, which is what draws the state',
  );
  assert.ok(tree.states[':active'], 'up to the window, as `:hover` does');

  wnd.emit('mouseup', { ...centre(inner), keycode: 1 });
  assert.ok(!control.states[':active'], 'the release ends it');
  assert.ok(!inner.states[':active'], 'over the whole chain');

  await x11Root.unmount();
});

test('the pressed fill is on the wire before the release', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(Button, { primary: true }, 'Go'),
  );
  const button = tree.children[0];
  const theme = button.theme;
  assert.notStrictEqual(theme.accent, theme.accentActive, 'a real change');
  wnd.ctx.ops.length = 0;

  // deliberately no await and no mouseup: holding the button down is the
  // whole of the gesture under test
  down(wnd, button);

  assert.ok(
    wnd.ctx.ops.some((op) => op.includes(theme.accentActive)),
    `painted ${theme.accentActive} from the press handler, ops: ${JSON.stringify(wnd.ctx.ops)}`,
  );

  await x11Root.unmount();
});

test('leaving the pressed control drops the press, returning restores it', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 20, padding: 10 } },
      h(Button, null, 'Here'),
      h(Button, null, 'There'),
    ),
  );
  const here = textNode(tree, 'Here').parent;
  const there = textNode(tree, 'There').parent;

  down(wnd, here);
  assert.ok(here.states[':active'], 'pressed');

  moveTo(wnd, there);
  assert.ok(
    !here.states[':active'],
    'the pointer left, so releasing there would activate nothing here',
  );
  assert.ok(
    !there.states[':active'],
    'and the button the pointer wandered onto is not pressed either — the ' +
      'press did not start on it',
  );

  moveTo(wnd, here);
  assert.ok(here.states[':active'], 'coming back re-arms it');

  up(wnd, here);
  assert.ok(!here.states[':active']);

  await x11Root.unmount();
});

test('the press state agrees with the click the release synthesizes', async () => {
  let clicks = 0;
  const { x11Root, wnd, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 20, padding: 10 } },
      h(Button, { onPress: () => clicks++ }, 'Act'),
      h(Button, null, 'Other'),
    ),
  );
  const act = textNode(tree, 'Act').parent;
  const other = textNode(tree, 'Other').parent;

  down(wnd, act);
  moveTo(wnd, other);
  assert.ok(!act.states[':active'], 'no longer drawn as pressed');
  up(wnd, other);
  assert.strictEqual(clicks, 0, 'and no click fired, which is what it meant');

  down(wnd, act);
  up(wnd, act);
  assert.strictEqual(clicks, 1, 'a press and release on the same control does');

  await x11Root.unmount();
});

test('a press the pointer carries out of the window presses only the window', async () => {
  const { x11Root, wnd, tree } = await mount(h(Button, null, 'Edge'));
  const button = textNode(tree, 'Edge').parent;

  down(wnd, button);
  assert.ok(button.states[':active']);

  wnd.emit('mouseout', { x: -5, y: -5 });
  assert.ok(!button.states[':active'], 'the button gave the press up');
  assert.ok(
    tree.states[':active'],
    'the window kept it: a release out there still clicks the window',
  );

  up(wnd, button);
  assert.ok(!tree.states[':active']);

  await x11Root.unmount();
});

// --- the controls -------------------------------------------------------

test('a select drops its menu on the press, not on the release', async () => {
  const { app, x11Root, wnd, tree } = await mount(
    h(Select, {
      value: 'utf-8',
      options: ['utf-8', 'latin-1'],
      onChange: () => {},
      style: { width: 140 },
    }),
  );
  const trigger = find(tree, (n) => n.props.role === 'combobox');
  const before = app.windows.length;

  // no mouseup: the menu is expected to be up while the button is still down,
  // which is what every desktop toolkit does and what makes a dropdown worth
  // holding — you are meant to be looking at the options
  down(wnd, trigger);
  await settle();
  assert.strictEqual(
    app.windows.length,
    before + 1,
    'the popup window exists before the button came back up',
  );

  up(wnd, trigger);
  await settle();
  assert.strictEqual(
    app.windows.length,
    before + 1,
    'and the release does not toggle it straight back shut',
  );

  await x11Root.unmount();
});

test('a held switch tints its track before the thumb moves', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(Switch, { checked: false, onChange: () => {} }),
  );
  const track = find(tree, (n) => n.props.role === 'switch');
  const theme = track.theme;
  const thumbLeft = track.children[0].style.left;

  // press the *thumb*, which is the child a real pointer lands on more often
  // than not — the press has to reach the track it sits in
  down(wnd, track.children[0]);
  assert.ok(track.states[':active'], 'the track heard a press on its thumb');
  assert.strictEqual(
    track._targetStyle.backgroundColor,
    theme.dimActive,
    'and answers it, while the thumb has not moved yet',
  );
  assert.strictEqual(
    track.children[0].style.left,
    thumbLeft,
    'the thumb only slides once the switch has actually flipped',
  );

  await x11Root.unmount();
});

test('a held tab darkens, including the tab already selected', async () => {
  const items = [
    { id: 'a', label: 'Alpha', content: h('text', null, 'A') },
    { id: 'b', label: 'Beta', content: h('text', null, 'B') },
  ];
  const { x11Root, wnd, tree } = await mount(h(Tabs, { items }));
  const alpha = textNode(tree, 'Alpha').parent;
  const beta = textNode(tree, 'Beta').parent;
  const theme = alpha.theme;

  down(wnd, beta);
  assert.strictEqual(
    beta._targetStyle.backgroundColor,
    theme.surfaceActive,
    'an unselected tab answers the press',
  );
  up(wnd, beta);
  await settle();

  // 'Beta' is now the selected tab and already carries `surfaceHover`; a
  // second press on it is the one that used to look ignored
  down(wnd, beta);
  assert.strictEqual(
    beta._targetStyle.backgroundColor,
    theme.surfaceActive,
    'and so does the selected one, which has a fill of its own',
  );

  await x11Root.unmount();
});

test('a checkbox pressed away from its well still darkens the well', async () => {
  // The case a style block cannot reach: `:active` marks the press chain,
  // and the 16px well is a *sibling* of the label the press lands on. This
  // is why `useControl` keeps a React `pressed` for it.
  const { x11Root, wnd, tree } = await mount(
    h(
      Checkbox,
      { checked: false, onChange: () => {}, style: { width: 200, height: 30 } },
      'Ready',
    ),
  );
  const row = find(tree, (n) => n.props.role === 'checkbox');
  const well = row.children[0];
  const theme = row.theme;
  const resting = well.style.backgroundColor;
  assert.notStrictEqual(resting, theme.surfaceActive, 'a real change to make');

  // well ends at x = 16; press well clear of it, where the label sits
  const y = row.abs.y + row.abs.height / 2;
  wnd.emit('mousedown', { x: row.abs.x + 120, y, keycode: 1 });
  await settle();
  assert.ok(!well.states[':active'], 'the well was never on the press chain');
  assert.strictEqual(
    well.style.backgroundColor,
    theme.surfaceActive,
    'and answered the press all the same',
  );

  wnd.emit('mouseup', { x: row.abs.x + 120, y, keycode: 1 });
  await settle();
  assert.strictEqual(
    well.style.backgroundColor,
    resting,
    'the release ends it',
  );

  await x11Root.unmount();
});

// --- the palette --------------------------------------------------------

test('a palette that names a hover gets the matching pressed step', () => {
  const light = resolveTheme({ accent: '#2980b9', accentHover: '#1f6693' });
  assert.strictEqual(
    light.accentActive,
    'rgba(21, 76, 109, 1)',
    'one more step in the direction the hover already went',
  );

  const dark = resolveTheme({
    background: '#1c1c1e',
    surfaceHover: '#48484a',
  });
  const [, r, g, b] = /rgba\((\d+), (\d+), (\d+)/.exec(dark.surfaceActive);
  assert.ok(
    Number(r) > 0x48 && Number(g) > 0x48 && Number(b) > 0x4a,
    `a dark theme steps lighter, not darker (got ${dark.surfaceActive})`,
  );
});

test('an explicit pressed colour wins, and an untouched family is inherited', () => {
  const explicit = resolveTheme({
    accentHover: '#1f6693',
    accentActive: '#000080',
  });
  assert.strictEqual(explicit.accentActive, '#000080');

  const unrelated = resolveTheme({ fontSize: 18 });
  assert.strictEqual(
    unrelated.accentActive,
    resolveTheme(null).accentActive,
    'a palette that did not touch the accent family keeps what was in force',
  );
});
