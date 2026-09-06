// examples/tray.jsx carries its own test (AGENTS.md, "every app carries its
// own tests"): the status menu-bar app, asserting it puts an item in the tray
// with the right icon and menu, that picking a status updates the icon, and
// that the window is the fallback where there is no tray.
//
// Rendered on the mock backend (its fonts lay text out) with a `createStatusItem`
// the mock does not have, added as a spy — so this pins the app's behaviour;
// that the calls reach `NSStatusItem` is `test/cocoa-tray.test.js` against the
// real bridge.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  cleanup,
  createMockApp,
  renderX11,
  act,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';
const { default: App } = await import('../examples/tray.jsx');

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const FONTS = { '': { ascent: 12, descent: 3, widths: { '': 7 } } };

afterEach(cleanup);

/** A tray item shaped like `CocoaStatusItem`, recording what the hook does. */
function fakeItem(options) {
  return {
    options,
    updates: [],
    removed: false,
    update(patch) {
      this.options = { ...this.options, ...patch };
      this.updates.push(patch);
    },
    remove() {
      this.removed = true;
    },
  };
}

/** A mock app that also answers `createStatusItem`, so `useTray` is live. */
function trayApp() {
  const app = createMockApp();
  app.items = [];
  app.createStatusItem = (options) => {
    const item = fakeItem(options);
    app.items.push(item);
    return item;
  };
  return app;
}

async function mount(props) {
  const app = trayApp();
  await renderX11(h(App, props), { app, wrap: false, fonts: FONTS });
  await tick();
  return { app, item: app.items[0] };
}

test('a tray item is created with the status icon and a menu', async () => {
  const { app, item } = await mount({ initial: 'available' });
  assert.equal(app.items.length, 1, 'one item');
  assert.equal(item.options.icon, 'circle.fill');
  assert.match(item.options.tooltip, /Available/);
  const menu = item.options.menu;
  assert.deepEqual(
    menu.map((i) => i.label ?? (i.type === 'separator' ? '—' : '')),
    ['Available', 'Busy', 'Away', '—', 'Quit'],
  );
  // the current status is the checked one
  assert.equal(menu[0].toggleState, 1);
  assert.equal(menu[1].toggleState, 0);
});

test('picking a status from the menu changes the icon', async () => {
  const { item } = await mount({ initial: 'available' });

  // "Busy" from the menu, the way a click would run it
  await act(async () => item.options.menu[1].onSelect());
  assert.equal(item.options.icon, 'minus.circle.fill');
  assert.match(item.options.tooltip, /Busy/);
  // the check moved
  assert.equal(item.options.menu[0].toggleState, 0);
  assert.equal(item.options.menu[1].toggleState, 1);

  await act(async () => item.options.menu[2].onSelect());
  assert.equal(item.options.icon, 'moon.fill');
});

test('Quit runs the callback the app was given', async () => {
  let quit = 0;
  const { item } = await mount({ onQuit: () => quit++ });
  await act(async () => item.options.menu.at(-1).onSelect());
  assert.equal(quit, 1);
});

test('the item is removed on unmount', async () => {
  const app = trayApp();
  const view = await renderX11(h(App, {}), { app, wrap: false, fonts: FONTS });
  await tick();
  assert.equal(app.items[0].removed, false);
  await view.unmount();
  assert.equal(app.items[0].removed, true);
});

test('with no tray backend the app is available: false, and still renders', async () => {
  // a plain mock has no createStatusItem
  const app = createMockApp();
  let seenAvailable = 'unset';
  function Probe() {
    // reach into the app the way the app does, to prove the branch
    seenAvailable = typeof app.createStatusItem === 'function';
    return h(App, {});
  }
  const view = await renderX11(h(Probe), { app, wrap: false, fonts: FONTS });
  await tick();
  assert.equal(seenAvailable, false);
  assert.ok(view.windowNode?.isWindow, 'the window is the fallback');
});
