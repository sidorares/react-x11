// The focus state: what a control shows once it holds the keyboard, and in
// particular what it shows when the pointer is what put it there.
//
// A press deliberately sets `:focus` without `:focus-visible` — a ring on
// every click is the noise CSS grew the distinction to remove. That left
// three ways for a mouse user to focus something and be told nothing at all,
// and all three are the same mistake made in different places: the fact was
// recorded and then had nowhere to show up.
//
//  1. A **text field** is the exception CSS itself makes. The click says
//     where the caret went; it does not say that every keystroke from now on
//     lands there, and that is the part worth drawing.
//  2. `<Checkbox>`/`<Radio>` put focus and hover in the *same* channel, the
//     well's border, with hover checked first — and a click ends with the
//     pointer on the control it just focused, so the focus colour was
//     unreachable by the one gesture that focuses by pointer.
//  3. A **filled** well (checked, or the selected radio) had spent that
//     border on the fill, so its focus branch was dead code in the ternary
//     under it — no ring, pointer or keyboard, ever.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { Checkbox, Radio, RadioGroup, createRoot } from '../src/index.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const rootOf = (app) => app.windows[0]._reactX11Node;

const all = (node, out = []) => {
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
};
const byRole = (tree, role) => all(tree).filter((n) => n.props.role === role);
/** Everything here is named, and every assertion is about a name or a
 * colour: `assert.equal` on two nodes inspects the whole retained tree when
 * it fails, which is twenty seconds and a diff nobody can read. */
const byName = (tree, name) =>
  all(tree).find((n) => n.props.name === name) ?? null;

const centre = (node) => ({
  x: node.abs.x + node.abs.width / 2,
  y: node.abs.y + node.abs.height / 2,
});

/** A click, pointer and all: the motion that puts the pointer *on* the
 * control is half of what these tests are about, so it is not optional. */
const click = (wnd, node) => {
  wnd.emit('mousemove', centre(node));
  wnd.emit('mousedown', { ...centre(node), keycode: 1 });
  wnd.emit('mouseup', { ...centre(node), keycode: 1 });
};

async function mount(element, width = 300, height = 200) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width, height }, element));
  await settle();
  return { app, x11Root, wnd: app.windows[0], tree: rootOf(app) };
}

// Text measures 0x0 against the mock, which has no fonts, so a field a press
// can land on is sized by hand.
const FIELD = { width: 100, height: 20 };

// --- 1. the field a click is about to type into -----------------------------

test('a click into a text field lights a ring; a click on a box does not', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(
      'box',
      { style: { gap: 10 } },
      h('textinput', { name: 'field', style: FIELD }),
      h('box', { name: 'plain', focusable: true, style: FIELD }),
    ),
  );
  const field = byName(tree, 'field');
  const plain = byName(tree, 'plain');

  click(wnd, field);
  await settle();
  assert.strictEqual(field.states[':focus'], true, 'the press focused it');
  assert.strictEqual(
    field.states[':focus-visible'],
    true,
    'and it shows — the keys are going here now, which the click did not say',
  );

  click(wnd, plain);
  await settle();
  assert.strictEqual(plain.states[':focus'], true, 'this one is focused too');
  assert.strictEqual(
    plain.states[':focus-visible'],
    false,
    'but takes no keyboard of its own, so the click was the whole story',
  );
  assert.strictEqual(
    field.states[':focus-visible'],
    false,
    'and the field let go of its ring with its focus',
  );

  await x11Root.unmount();
});

test('the rule is "holds editable text", not "is a <textinput>"', async () => {
  // `<textarea>` is the second built-in, and it answers through the same
  // predicate the AT-SPI EDITABLE state uses (`isTextControl`, src/a11y.js)
  // rather than through a kind list this rule keeps its own copy of.
  const { x11Root, wnd, tree } = await mount(
    h('textarea', { name: 'area', style: { width: 100, height: 40 } }),
  );
  const area = byName(tree, 'area');

  click(wnd, area);
  await settle();
  assert.strictEqual(area.states[':focus-visible'], true);

  await x11Root.unmount();
});

// --- 2. focus and hover, in two channels ------------------------------------

test('a clicked checkbox shows focus while the pointer is still on it', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(Checkbox, { checked: false, label: 'Shout it', onChange: () => {} }),
  );
  const control = byRole(tree, 'checkbox')[0];
  const well = control.children[0];
  const theme = control.theme;

  wnd.emit('mousemove', centre(control));
  await settle();
  assert.strictEqual(
    well.style.borderColor,
    theme.textMuted,
    'hovering firms the ring up, as it always has',
  );

  click(wnd, control);
  await settle();
  assert.strictEqual(
    tree.events.focused,
    control,
    'the click focused the control',
  );
  assert.strictEqual(
    control.states[':hover'],
    true,
    'and left the pointer sitting on it — this is the whole trap',
  );
  assert.strictEqual(
    well.style.borderColor,
    theme.borderFocus,
    'focus is a colour and hover is a step, so hover cannot overwrite it',
  );
  assert.strictEqual(
    well.style.backgroundColor,
    theme.surfaceHover,
    'and the hover still says so, in the channel it moved to',
  );

  await x11Root.unmount();
});

test('an unselected radio does too', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(
      RadioGroup,
      { value: 'normal', onChange: () => {} },
      h(Radio, { value: 'normal', label: 'normal' }),
      h(Radio, { value: 'bold', label: 'bold' }),
    ),
  );
  const [, bold] = byRole(tree, 'radio');
  const well = bold.children[0];
  const theme = bold.theme;

  click(wnd, bold);
  await settle();
  assert.strictEqual(bold.states[':hover'], true, 'pointer still on it');
  assert.strictEqual(well.style.borderColor, theme.borderFocus);

  await x11Root.unmount();
});

// --- 3. the well with no border left to spend -------------------------------

test('a checked checkbox rings its well, since its border is the fill', async () => {
  const { x11Root, wnd, tree } = await mount(
    h(Checkbox, { checked: true, label: 'Shout it', onChange: () => {} }),
  );
  const control = byRole(tree, 'checkbox')[0];
  const well = control.children[0];
  const theme = control.theme;
  assert.strictEqual(
    well.style.outlineWidth,
    undefined,
    'nothing to draw before it is focused — and nothing to widen its damage',
  );

  click(wnd, control);
  await settle();
  assert.strictEqual(well.style.outlineWidth, theme.focusRingWidth);
  assert.strictEqual(well.style.outlineColor, theme.focusRing);
  assert.strictEqual(
    well.style.borderColor,
    theme.accentHover,
    'the fill still steps for the hover it is under',
  );

  await x11Root.unmount();
});

test('…and so does the selected radio, which a click cannot otherwise change', async () => {
  // The one radio in a group that can be clicked without anything happening
  // was also the only one with nothing to show for the click.
  const { x11Root, wnd, tree } = await mount(
    h(
      RadioGroup,
      { value: 'normal', onChange: () => {} },
      h(Radio, { value: 'normal', label: 'normal' }),
      h(Radio, { value: 'bold', label: 'bold' }),
    ),
  );
  const [normal, bold] = byRole(tree, 'radio');
  const well = normal.children[0];
  const theme = normal.theme;

  click(wnd, normal);
  await settle();
  assert.strictEqual(well.style.outlineWidth, theme.focusRingWidth);
  assert.strictEqual(well.style.outlineColor, theme.focusRing);

  click(wnd, bold);
  await settle();
  assert.strictEqual(
    well.style.outlineWidth,
    undefined,
    'and it goes when focus does',
  );

  await x11Root.unmount();
});

// --- the ring a widget draws itself has to be erasable ----------------------

test('an outline a style swap takes away claims where it was', async () => {
  // The enabling fix for the two above, and a hole in the `outlineWidth`
  // escape hatch on its own: every claim downstream of a style swap is
  // bounded by `paintBounds()` computed from the style *now in force*, so a
  // node that drops a ring would repaint its own box and leave the ring
  // printed around it. `boxShadow` had this; the outline did not, because
  // core's own ring never arrives this way — `EventManager.focus` claims it
  // while `:focus-visible` is still on.
  const RING = { outlineWidth: 4, outlineColor: '#ff0000', outlineOffset: 2 };
  const BOX = { marginTop: 20, marginLeft: 20, width: 40, height: 20 };
  let setOn;
  const App = () => {
    const [on, set] = React.useState(true);
    setOn = set;
    return h('box', { name: 'b', style: { ...BOX, ...(on ? RING : null) } });
  };
  const { app, x11Root, tree } = await mount(h(App));
  const box = byName(tree, 'b');
  const lit = box.paintBounds();
  assert.ok(
    lit.x <= box.abs.x - 6,
    `the ring reaches width + offset outside the box: ${JSON.stringify(lit)}`,
  );

  const claims = [];
  const invalidate = tree.invalidate.bind(tree);
  tree.invalidate = (full, target, reason) => {
    if (reason === 'outline') claims.push(target);
    return invalidate(full, target, reason);
  };
  setOn(false);
  await settle();

  assert.strictEqual(
    box.style.outlineWidth,
    undefined,
    'the ring is off the style',
  );
  assert.deepStrictEqual(
    claims,
    [lit],
    'and where it used to be was claimed, before the bounds shrank under it',
  );

  tree.invalidate = invalidate;
  await x11Root.unmount();
  assert.ok(app);
});
