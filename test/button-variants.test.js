// The Button axes (#369): `variant` is how much chrome the control carries,
// `size` is the toolbar metric, and the resolved label ink lands on the box
// so an *element* child — an <Icon>, a <text> — is coloured the way a string
// child always was.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { Button, Icon, createRoot } from '../src/index.js';
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

async function mount(element, width = 400, height = 300) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width, height }, element));
  await settle();
  return { app, x11Root, wnd: app.windows[0], tree: rootOf(app) };
}

const centre = (node) => ({
  x: node.abs.x + node.abs.width / 2,
  y: node.abs.y + node.abs.height / 2,
});

const buttons = (tree) => {
  const found = [];
  const walk = (n) => {
    if (n.props?.role === 'button') found.push(n);
    for (const c of n.children) if (!c.isWindow) walk(c);
  };
  walk(tree);
  return found;
};

// --- the chrome axis ----------------------------------------------------

test('outline keeps the border and loses the fill; ghost loses both', async () => {
  const { x11Root, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 8 } },
      h(Button, { variant: 'outline' }, 'Outline'),
      h(Button, { variant: 'ghost' }, 'Ghost'),
    ),
  );
  const [outline, ghost] = buttons(tree);
  const theme = outline.theme;

  assert.strictEqual(outline.style.backgroundColor, 'transparent');
  assert.strictEqual(outline.style.borderColor, theme.border);

  assert.strictEqual(ghost.style.backgroundColor, 'transparent');
  assert.strictEqual(ghost.style.borderColor, 'transparent');

  await x11Root.unmount();
});

test('primary speaks in the accent: the fill when solid, the ink and border otherwise', async () => {
  const { x11Root, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 8 } },
      h(Button, { primary: true }, 'Solid'),
      h(Button, { primary: true, variant: 'outline' }, 'Outline'),
      h(Button, { primary: true, variant: 'ghost' }, 'Ghost'),
    ),
  );
  const [solid, outline, ghost] = buttons(tree);
  const theme = solid.theme;

  assert.strictEqual(solid.style.backgroundColor, theme.accent);
  assert.strictEqual(solid.style.color, theme.accentText);

  assert.strictEqual(outline.style.backgroundColor, 'transparent');
  assert.strictEqual(outline.style.borderColor, theme.accent);
  assert.strictEqual(outline.style.color, theme.accent);

  assert.strictEqual(ghost.style.borderColor, 'transparent');
  assert.strictEqual(ghost.style.color, theme.accent);

  await x11Root.unmount();
});

test('every variant is the same sum, so a mixed row lines up', async () => {
  // The ghost button keeps the border *width* and loses only the colour;
  // otherwise it would come out 2px shorter than the solid one beside it.
  const { x11Root, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' } },
      h(Button, null, 'A'),
      h(Button, { variant: 'outline' }, 'B'),
      h(Button, { variant: 'ghost' }, 'C'),
    ),
  );
  const [a, b, c] = buttons(tree);
  assert.ok(a.abs.height > 0, 'laid out');
  assert.strictEqual(b.abs.height, a.abs.height, 'outline matches solid');
  assert.strictEqual(c.abs.height, a.abs.height, 'ghost matches solid');

  await x11Root.unmount();
});

// --- the size axis ------------------------------------------------------

test('size="small" halves the control padding, from the palette', async () => {
  const { x11Root, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' } },
      h(Button, null, 'Medium'),
      h(Button, { size: 'small' }, 'Small'),
    ),
  );
  const [medium, small] = buttons(tree);
  const theme = medium.theme;
  const shrink = 2 * (theme.paddingY - Math.round(theme.paddingY / 2));
  assert.strictEqual(medium.abs.height - small.abs.height, shrink);

  await x11Root.unmount();
});

// --- the ink reaches element children -----------------------------------

test('an element child inherits the resolved label colour', async () => {
  const { x11Root, tree } = await mount(
    h(
      'box',
      { style: { flexDirection: 'row', gap: 8 } },
      h(Button, { primary: true }, h(Icon, { name: 'chevronRight' }), 'Go'),
      h(Button, { disabled: true }, h(Icon, { name: 'close' }), 'No'),
    ),
  );
  const [primary, disabled] = buttons(tree);
  const theme = primary.theme;
  const iconOf = (btn) => find(btn, (n) => n.kind === 'canvas');

  assert.strictEqual(
    iconOf(primary).resolvedTextStyle().color,
    theme.accentText,
    'the icon reads the same ink the label does',
  );
  assert.strictEqual(
    iconOf(disabled).resolvedTextStyle().color,
    theme.textMuted,
    'and dims with the control when it is disabled',
  );

  await x11Root.unmount();
});

// --- the press still answers without chrome ------------------------------

test('a held ghost button paints the neutral pressed wash', async () => {
  // A chrome-less button still owes an answer on the press (AGENTS.md,
  // "Answer the input"): the surface ramp is the feedback the accent fill
  // provides for solid, and it has to reach the wire before the release.
  const { x11Root, wnd, tree } = await mount(
    h(Button, { variant: 'ghost' }, 'Go'),
  );
  const [button] = buttons(tree);
  const theme = button.theme;
  wnd.ctx.ops.length = 0;

  // deliberately no mouseup: holding the button is the gesture under test
  wnd.emit('mousedown', { ...centre(button), keycode: 1 });

  assert.ok(
    wnd.ctx.ops.some((op) => op.includes(theme.surfaceActive)),
    `painted ${theme.surfaceActive} from the press handler`,
  );

  await x11Root.unmount();
});

// --- the call-site check ------------------------------------------------

test('an unknown variant or size throws before anything renders', () => {
  // Reachable without a tree, as <Icon name>'s check is: the throw is
  // ahead of the hooks on purpose, so the message lands on the call site.
  assert.throws(
    () => Button({ variant: 'filled', children: 'x' }),
    /one of solid, outline, ghost/,
  );
  assert.throws(
    () => Button({ size: 'tiny', children: 'x' }),
    /one of medium, small/,
  );
});
