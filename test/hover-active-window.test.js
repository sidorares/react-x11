// Hover belongs to the active window, where the platform says so
// (`EventManager.hoverLive`, `app.hoverNeedsActiveWindow`).
//
// On macOS a window that is not the active one does not track the pointer.
// The Cocoa backend delivered its motion all the same, so a button in a
// background window lit up under the pointer and a link in a document
// underlined — with an arrow over it, since the window server ignores a
// cursor set by an application that is not the active one. Every other
// backend hovers in a window without the keyboard, as every toolkit on
// those platforms does, and none of this applies to them.
import { afterEach, test } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import { createRoot } from '../src/index.js';
import { registerElement, unregisterElement } from '../src/host.js';
import { Node } from '../src/node.js';
import { Dialog } from '../src/components/index.js';
import { createMockApp, moveMouse, pressButton } from './helpers/mock-app.js';

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

/** An element that paints its own hover, as a document or a graph does. */
class HoverPane extends Node {
  constructor(props, app) {
    super('hoverpane', props, app);
    this.seen = [];
  }
  defaultMouseMove(ev) {
    this.seen.push(`move ${ev.x},${ev.y}`);
  }
  defaultMouseLeave() {
    this.seen.push('leave');
  }
  cursorAt() {
    return 'pointer';
  }
}

/** A window of two 100-pixel rows, a button over a pane, on an app that
 *  keeps hover to the active window (`platform` true) or does not. */
async function scene({ platform = true, extra = null } = {}) {
  registerElement('hoverpane', {
    create: (props, app) => new HoverPane(props, app),
    childrenAllowed: false,
    override: true,
  });
  const app = createMockApp();
  if (platform) app.hoverNeedsActiveWindow = true;
  const root = await createRoot({ app });
  roots.push(root);
  const log = [];
  const row = React.createRef();
  const pane = React.createRef();
  root.render(
    h(
      'window',
      {
        width: 200,
        height: 200,
        onMouseOut: () => log.push('out'),
      },
      h('box', {
        ref: row,
        style: { height: 100, flexShrink: 0 },
        onMouseEnter: () => log.push('enter'),
        onMouseLeave: () => log.push('leave'),
        onMouseMove: () => log.push('move'),
        onClick: () => log.push('click'),
      }),
      h('hoverpane', { ref: pane, style: { height: 100, flexShrink: 0 } }),
      extra,
    ),
  );
  await frames();
  return {
    app,
    wnd: app.windows[0],
    log,
    row: row.current,
    pane: pane.current,
  };
}

const cursors = (wnd) =>
  wnd.calls.filter(([name]) => name === 'setCursor').map(([, c]) => c);

test('a window that is not the active one hovers nothing', async () => {
  const { wnd, log, row, pane } = await scene();
  wnd.emit('blur', {});
  moveMouse(wnd, 50, 50);
  moveMouse(wnd, 50, 150);
  await frames();
  assert.deepStrictEqual(log, [], 'no enter, no motion');
  assert.ok(!row.states[':hover'], 'and no `:hover`');
  assert.deepStrictEqual(pane.seen, [], 'nor for an element drawing its own');
  assert.deepStrictEqual(cursors(wnd), [], 'and the cursor is not asked for');
});

test('losing the keyboard drops the hover, as the pointer leaving would', async () => {
  const { wnd, log, row, pane } = await scene();
  moveMouse(wnd, 50, 50);
  await frames();
  assert.ok(row.states[':hover']);
  log.length = 0;

  wnd.emit('blur', {});
  assert.deepStrictEqual(log, ['leave'], 'not `out`: it is still over it');
  assert.ok(!row.states[':hover']);

  moveMouse(wnd, 50, 150);
  await frames();
  wnd.emit('focus', {});
  wnd.emit('blur', {});
  assert.deepStrictEqual(
    pane.seen,
    ['move 50,150', 'leave'],
    'an element drawing its own hover is told to clear it',
  );
  assert.strictEqual(cursors(wnd).at(-1), null, 'and its cursor goes');
});

test('the hover comes back with the keyboard, at a pointer that did not move', async () => {
  const { wnd, log, row } = await scene();
  wnd.emit('blur', {});
  moveMouse(wnd, 50, 50);
  await frames();
  assert.deepStrictEqual(log, []);

  wnd.emit('focus', {});
  assert.deepStrictEqual(log, ['enter'], 'no move: the pointer did not');
  assert.ok(row.states[':hover']);
});

test('…and not where the pointer left while the window was away', async () => {
  const { wnd, log, row } = await scene();
  moveMouse(wnd, 50, 50);
  wnd.emit('blur', {});
  wnd.emit('mouseout', { x: 50, y: 50 });
  log.length = 0;
  wnd.emit('focus', {});
  await frames();
  assert.deepStrictEqual(log, []);
  assert.ok(!row.states[':hover']);
});

test('a frame that lays out does not hover a background window', async () => {
  // `refreshHover` is asked after every frame that laid out: a scroll of a
  // background window, which the wheel reaches whoever has the keyboard
  const { wnd, log } = await scene();
  wnd.emit('blur', {});
  moveMouse(wnd, 50, 50);
  wnd._reactX11Node.events.refreshHover();
  await frames();
  assert.deepStrictEqual(log, []);
});

test('a press in a background window is still a press, and its gesture runs', async () => {
  // the first click on a window acts as well as activating it, and the
  // focus event may land on either side of the press
  const { wnd, log } = await scene();
  wnd.emit('blur', {});
  pressButton(wnd, 50, 50, { release: false });
  moveMouse(wnd, 60, 50);
  assert.deepStrictEqual(log, ['enter', 'move'], 'the drag is delivered');
  pressButton(wnd, 60, 50, { press: false });
  assert.strictEqual(log.at(-1), 'click');
});

test('a backend that does not ask for it hovers in any window', async () => {
  const { wnd, log, row } = await scene({ platform: false });
  wnd.emit('blur', {});
  moveMouse(wnd, 50, 50);
  await frames();
  assert.deepStrictEqual(log, ['enter', 'move']);
  assert.ok(row.states[':hover']);
});

test('a popup nothing manages hovers whoever has the keyboard', async () => {
  // a menu, a dropdown, a popover under a tray item: on the screen because
  // the user asked for it, in an application that may have no active window
  const item = React.createRef();
  const { app } = await scene({
    extra: h(
      'popup',
      { x: 10, y: 10, width: 100, height: 100 },
      h('box', { ref: item, style: { height: 100 } }),
    ),
  });
  const [owner, popup] = app.windows;
  owner.emit('blur', {});
  moveMouse(popup, 50, 50);
  await frames();
  assert.ok(item.current.states[':hover']);
});

test('a window whose dialog has the keyboard is still the active one', async () => {
  // the owner is main under a key panel; the focus is the group's answer,
  // and the two events arrive in an order nobody chooses
  for (const order of ['blur first', 'focus first']) {
    const { app, log, row } = await scene({
      extra: h(
        Dialog,
        { open: true, title: 'D', width: 120, height: 80, onClose: () => {} },
        h('box', { style: { height: 20 } }),
      ),
    });
    const [owner, popup] = app.windows;
    moveMouse(owner, 50, 50);
    await frames();
    if (order === 'blur first') {
      owner.emit('blur', {});
      popup.emit('focus', {});
    } else {
      popup.emit('focus', {});
      owner.emit('blur', {});
    }
    assert.ok(row.states[':hover'], order);
    log.length = 0;
    moveMouse(owner, 60, 50);
    assert.deepStrictEqual(log, ['move'], order);

    // …and the dialog's hover goes with the application's
    popup.emit('blur', {});
    assert.ok(!row.states[':hover'], `${order}: nothing has the keyboard`);
    for (const root of roots.splice(0)) await root.unmount();
  }
});
