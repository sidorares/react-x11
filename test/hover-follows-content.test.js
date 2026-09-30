// Hover follows content (`EventManager.refreshHover`): content that scrolls
// under a pointer that stays still is hovered where it lands, as a browser
// hovers it at the frame after the scroll.
//
// Hover was a question asked on motion alone, so a wheel scrolled a list
// under a still pointer and the row that had been under it kept `:hover`,
// its enter and leave never came, and an element drawing its own hover —
// a document, whose hovered link carries a shadow — kept that shadow on
// content scrolled away from the pointer, until the pointer next moved.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import {
  createMockApp,
  moveMouse,
  pressButton,
  spinWheel,
} from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const frames = async (n = 3) => {
  for (let i = 0; i < n; i++) await tick();
};

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  unregisterElement('hoverpane');
});

/** A scroll pane of forty 40-pixel rows that log their hover, in a window
 *  the pointer is over. */
async function list() {
  const app = createMockApp();
  const root = await createRoot({ app });
  roots.push(root);
  const log = [];
  const rows = [];
  root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h(
        'box',
        { style: { overflow: 'scroll', height: 200, flexShrink: 0 } },
        ...Array.from({ length: 40 }, (_, i) =>
          h('box', {
            key: i,
            ref: (node) => (rows[i] = node),
            style: { height: 40, flexShrink: 0 },
            onMouseEnter: () => log.push(`enter ${i}`),
            onMouseLeave: () => log.push(`leave ${i}`),
            onMouseMove: () => log.push(`move ${i}`),
          }),
        ),
      ),
    ),
  );
  await frames();
  return { app, wnd: app.windows[0], log, rows };
}

test('a row scrolled under a still pointer is hovered, and the one scrolled away is not', async () => {
  const { wnd, log, rows } = await list();
  moveMouse(wnd, 50, 50); // row 1, 40 to 80
  await frames();
  assert.ok(rows[1].states[':hover'], 'row 1 under the pointer');
  log.length = 0;

  spinWheel(wnd, 50, 50); // a notch, 48 pixels: row 2 is under it now
  await frames();
  assert.deepStrictEqual(
    log,
    ['leave 1', 'enter 2'],
    'no move: the pointer did not',
  );
  assert.ok(rows[2].states[':hover']);
  assert.ok(!rows[1].states[':hover']);
});

test('nothing changes while a press holds the pointer', async () => {
  const { wnd, log, rows } = await list();
  moveMouse(wnd, 50, 50);
  await frames();
  pressButton(wnd, 50, 50, { release: false });
  log.length = 0;
  spinWheel(wnd, 50, 50);
  await frames();
  assert.deepStrictEqual(log, [], 'hover is frozen for the gesture');
  assert.ok(rows[1].states[':hover']);
});

test('a pointer that left the window hovers nothing a scroll brings', async () => {
  const { wnd, log } = await list();
  moveMouse(wnd, 50, 50);
  await frames();
  wnd.emit('mouseout', { x: 50, y: 50 });
  await frames();
  log.length = 0;
  // a scroll from somewhere else — a key, the application — moves the rows
  // under where the pointer was; it is not there any more
  wnd._reactX11Node.children[0].scrollTo({ y: 120 });
  await frames();
  assert.deepStrictEqual(log, []);
});

test('an element that paints its own hover hears the point again, as content moves under it', async () => {
  class HoverPane extends Node {
    constructor(props, app) {
      super('hoverpane', props, app);
      this.seen = [];
    }
    defaultMouseMove(ev) {
      this.seen.push(`${ev.x},${ev.y}`);
    }
  }
  registerElement('hoverpane', {
    create: (props, app) => new HoverPane(props, app),
    childrenAllowed: false,
    override: true,
  });
  const app = createMockApp();
  const root = await createRoot({ app });
  roots.push(root);
  const ref = React.createRef();
  root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h(
        'box',
        { style: { overflow: 'scroll', height: 200, flexShrink: 0 } },
        h('hoverpane', { ref, style: { height: 1000, flexShrink: 0 } }),
      ),
    ),
  );
  await frames();
  const wnd = app.windows[0];
  moveMouse(wnd, 30, 60);
  await frames();
  const pane = ref.current;
  assert.deepStrictEqual(pane.seen, ['30,60'], 'the motion');
  spinWheel(wnd, 30, 60);
  await frames();
  assert.ok(
    pane.seen.length >= 2,
    'and again after the scroll, at the same point',
  );
  assert.deepStrictEqual(new Set(pane.seen), new Set(['30,60']));
});
