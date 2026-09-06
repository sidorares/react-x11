// examples/badge.jsx carries its own test (AGENTS.md, "every app carries its
// own tests"): the inbox driven through its `fixtureInbox` seam, asserting it
// wires the launcher features — the unread badge, the Dock menu, and the
// attention that only fires while the window is unfocused.
//
// It renders on the mock backend, whose window records `setWmState` and whose
// fonts lay text out, with the two launcher methods the mock does not have
// (`setDockBadge`, `setDockMenu`) added as spies. So this pins the app's
// behaviour; that the calls it makes then reach the Dock is
// `test/cocoa-dock.test.js` against the real bridge.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  cleanup,
  createMockApp,
  renderX11,
  act,
} from '../src/testing/index.js';
import { setWindowStateForTests } from '../src/windowstate.js';

// The example auto-runs on import (it is a program); tell it not to, then
// import it dynamically so the env is set first — the timer.test.js rule.
process.env.REACT_X11_NO_AUTORUN = '1';
const { default: App, fixtureInbox } = await import('../examples/badge.jsx');

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const FONTS = {
  '': { ascent: 12, descent: 3, widths: { '': 7 } },
};

afterEach(cleanup);

/** A mock app that also answers the two launcher calls the inbox makes. */
function inboxApp() {
  const app = createMockApp();
  app.badges = [];
  app.dockMenus = [];
  app.setDockBadge = (label) => app.badges.push(label);
  app.setDockMenu = (items) => app.dockMenus.push(items);
  return app;
}

async function mount(source) {
  const app = inboxApp();
  const view = await renderX11(h(App, { source }), {
    app,
    wrap: false,
    fonts: FONTS,
  });
  await tick();
  return { app, view, wnd: app.windows[0] };
}

test('the unread count is the badge, and reading clears it', async () => {
  const source = fixtureInbox({ interval: 0 });
  const { app } = await mount(source);

  assert.equal(app.badges.at(-1), null, 'empty inbox: cleared');

  await act(async () => source.simulate());
  assert.equal(app.badges.at(-1), '1');

  await act(async () => source.simulate());
  assert.equal(app.badges.at(-1), '2');
});

test('the Dock menu carries working actions', async () => {
  const source = fixtureInbox({ interval: 0 });
  const { app } = await mount(source);
  const items = app.dockMenus.at(-1);
  assert.deepEqual(
    items.map((i) => i.label ?? (i.type === 'separator' ? '—' : '')),
    ['Mark all read', '—', 'New message'],
  );

  // "New message" produces one — the same action the app's own button runs
  await act(async () => items[2].onSelect());
  assert.equal(app.badges.at(-1), '1');

  // "Mark all read" clears the badge
  await act(async () => items[0].onSelect());
  assert.equal(app.badges.at(-1), null);
});

test('a message that arrives while unfocused asks for attention, and only then', async () => {
  const source = fixtureInbox({ interval: 0 });
  const { view, wnd } = await mount(source);
  const attn = () =>
    wnd.calls.filter(
      (c) => c[0] === 'setWmState' && c[1] === 'demands_attention',
    );

  // focused (the default): a message does not bounce the icon
  await act(async () => source.simulate());
  assert.equal(
    attn().some((c) => c[2] === 'add'),
    false,
    'looking: no attention',
  );

  // the user clicks away
  await act(async () => {
    setWindowStateForTests(view.app, view.windowNode, { focused: false });
  });

  // now a message arrives: attention is asked for
  await act(async () => source.simulate());
  assert.deepEqual(attn().at(-1), ['setWmState', 'demands_attention', 'add']);

  // and coming back withdraws it
  await act(async () => {
    setWindowStateForTests(view.app, view.windowNode, { focused: true });
  });
  assert.deepEqual(attn().at(-1), [
    'setWmState',
    'demands_attention',
    'remove',
  ]);
});

test('fixtureInbox: subscribe, simulate, and unsubscribe', () => {
  const source = fixtureInbox({ interval: 0, now: () => 1000 });
  const seen = [];
  const off = source.subscribe((m) => seen.push(m));
  const a = source.simulate();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], a);
  assert.equal(a.read, false);
  assert.equal(typeof a.from, 'string');
  off();
  source.simulate();
  assert.equal(seen.length, 1, 'unsubscribed');
});
