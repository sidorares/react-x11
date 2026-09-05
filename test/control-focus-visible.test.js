// `useControl().focusVisible` — the focus that shows, as the focus manager
// decided it: Tab lights `:focus-visible`, a click does not. A native
// control draws its ring for this and not for `focused`, since AppKit
// lights no ring round a checkbox the pointer clicked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { useControl } from '../src/components/theme.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function flush(fn) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => {
      await fn?.();
    });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  await tick();
}

/** A control that prints what the hook says about its focus. */
function Probe({ name }) {
  const { focused, focusVisible, props } = useControl(false, () => {});
  return h(
    'box',
    { name, ...props, style: { width: 40, height: 20 } },
    h(
      'text',
      null,
      `${focused ? 'focused' : 'blurred'}:${focusVisible ? 'ring' : 'no-ring'}`,
    ),
  );
}

const all = (node, out = []) => {
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
};
const byName = (tree, name) => all(tree).find((n) => n.props.name === name);
const said = (node) => node.children[0].props.children;

test('a click focuses without the ring; keyboard or script focus shows it', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  await flush(() =>
    root.render(
      h(
        'window',
        { width: 200, height: 100 },
        h(
          'box',
          { style: { flexDirection: 'row', gap: 8 } },
          h(Probe, { name: 'a' }),
          h(Probe, { name: 'b' }),
        ),
      ),
    ),
  );
  const wnd = app.windows[0];
  const tree = wnd._reactX11Node;
  const a = byName(tree, 'a');
  const b = byName(tree, 'b');
  assert.equal(said(a), 'blurred:no-ring');

  // a press: focus, and no ring
  const at = { x: a.abs.x + a.abs.width / 2, y: a.abs.y + a.abs.height / 2 };
  await flush(() => {
    wnd.emit('mousedown', { ...at, keycode: 1 });
    wnd.emit('mouseup', { ...at, keycode: 1 });
  });
  assert.equal(said(a), 'focused:no-ring');

  // moved by script — which, like Tab, is not a pointer: the ring shows
  await flush(() => b.focus());
  assert.equal(said(b), 'focused:ring');
  assert.equal(said(a), 'blurred:no-ring', 'and the blur clears both');

  await root.unmount();
});
