// The pointer crossing from a lit row onto one the selection cannot land on.
//
// A native menu goes dark the moment the pointer is over anything it cannot
// choose — a disabled item, a separator. Ours kept the row the pointer had
// left lit until it reached the next enabled one, because a disabled row
// reported nothing: the level never heard the pointer arrive.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';

import { ContextMenu, createRoot } from '../src/index.js';
import { DefaultTheme } from '../src/palette.js';
import { createMockApp, moveMouse } from '../src/testing/mock-app.js';

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

const all = (node, out = []) => {
  out.push(node);
  for (const child of node.children) all(child, out);
  return out;
};
const rows = (tree) =>
  all(tree).filter((n) => n.props.role === 'menuitem' && n.props.style);
const lit = (row) =>
  row.props.style.backgroundColor === DefaultTheme.hoverBackground;
const centre = (node) => ({
  x: node.abs.x + node.abs.width / 2,
  y: node.abs.y + node.abs.height / 2,
});

test('entering a disabled row puts the lit row out; so does a separator', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  const items = [
    { label: 'Cut' },
    { label: 'Paste', enabled: false },
    { type: 'separator' },
    { label: 'Delete' },
  ];
  await flush(() =>
    root.render(
      h(
        'window',
        { width: 300, height: 200 },
        h(
          ContextMenu,
          { items, style: { flexGrow: 1 } },
          h('box', { style: { flexGrow: 1 } }),
        ),
      ),
    ),
  );
  const wnd = app.windows[0];
  // a right click: mousedown, then the contextmenu the manager derives
  await flush(() => {
    wnd.emit('mousedown', { x: 50, y: 50, keycode: 3 });
    wnd.emit('mouseup', { x: 50, y: 50, keycode: 3 });
  });
  assert.equal(app.windows.length, 2, 'the menu opened');
  const popup = app.windows[1];
  const tree = wnd._reactX11Node;
  const [cut, paste, del] = rows(tree);
  assert.equal(cut.props.item?.label ?? 'Cut', 'Cut');

  await flush(() => moveMouse(popup, centre(cut).x, centre(cut).y));
  assert.ok(lit(cut), 'the enabled row lights');

  await flush(() => moveMouse(popup, centre(paste).x, centre(paste).y));
  assert.ok(!lit(cut), 'and goes out when the pointer is over a disabled row');
  assert.ok(!lit(paste), 'which does not light itself');

  await flush(() => moveMouse(popup, centre(del).x, centre(del).y));
  assert.ok(lit(del), 'the next enabled row lights');
  const sep = all(tree).find((n) => n.props.role === 'separator');
  await flush(() => moveMouse(popup, centre(sep).x, centre(sep).y));
  assert.ok(!lit(del), 'and goes out over a separator');

  await root.unmount();
});
