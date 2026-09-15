// examples/desktop.jsx carries its own test (AGENTS.md, "every app carries
// its own tests"): the backup agent driven through its `fixtureBackup` seam,
// asserting the thing the example exists to show — that one run's state
// reaches the tray, the badge, the quicklist and the banner at once, and that
// each of them is chosen by a *feature* rather than by a platform.
//
// Rendered on the mock backend (its fonts lay text out) with the three things
// the mock does not have added as spies — `createStatusItem`, `setDockBadge`,
// `setDockMenu`, plus a notification centre — so every rung is observable and
// nothing shells out to the developer's real desktop. That the calls then
// reach `NSStatusItem`/`NSDockTile` is `test/cocoa-tray.test.js` and
// `test/cocoa-dock.test.js`; that they reach StatusNotifierItem over a bus is
// `test/statusnotifier.test.js`.
//
// `offTheDesktopBus()` because this file mounts `useDesktopCapability()`,
// which dials the session bus on mount and re-probes on `NameOwnerChanged` —
// on a logged-in machine that is the developer's own panel.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import {
  act,
  cleanup,
  createMockApp,
  renderX11,
  screen,
} from '../src/testing/index.js';
import { _resetApplicationState } from '../src/application.js';
import { _resetLauncher } from '../src/launcher.js';
import { _resetNotifications } from '../src/notifications.js';
import { offTheDesktopBus } from './helpers/with-bus.js';

offTheDesktopBus();

process.env.REACT_X11_NO_AUTORUN = '1';
const { default: App, fixtureBackup } = await import('../examples/desktop.jsx');

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const FONTS = { '': { ascent: 12, descent: 3, widths: { '': 7 } } };

afterEach(async () => {
  await _resetNotifications();
  await _resetLauncher();
  _resetApplicationState();
});
afterEach(cleanup);

/** A tray item shaped like `CocoaStatusItem`, recording what the hook does. */
function fakeItem(options) {
  return {
    options,
    removed: false,
    update(patch) {
      this.options = { ...this.options, ...patch };
    },
    remove() {
      this.removed = true;
    },
  };
}

/**
 * A mock app wearing every desktop mechanism this example reaches for, so
 * each hook takes its top rung and every call lands somewhere a test can
 * read. A centre rather than a real daemon: `notify()` must not put a banner
 * on the machine running the suite.
 */
function desktopApp() {
  const app = createMockApp();
  app.items = [];
  app.badges = [];
  app.dockMenus = [];
  app.banners = [];
  app.createStatusItem = (options) => {
    const item = fakeItem(options);
    app.items.push(item);
    return item;
  };
  app.setDockBadge = (label) => app.badges.push(label);
  app.setDockMenu = (items) => app.dockMenus.push(items);
  app.notifications = {
    available: async () => true,
    async post(options) {
      app.banners.push(options);
      return { backend: 'cocoa', id: app.banners.length, options };
    },
  };
  return app;
}

async function mount({ app = desktopApp(), ...options } = {}) {
  const source = fixtureBackup({ tickMs: 0, total: 6, conflictsAt: [2, 4] });
  const view = await renderX11(h(App, { source, ...options }), {
    app,
    wrap: false,
    fonts: FONTS,
  });
  // two ticks: the item is created on the first, and the capability probes —
  // which every branch in the pane reads — settle on the next.
  await tick();
  await tick();
  return { app, view, source, item: () => app.items.at(-1) };
}

/** Advance the run by `n` files, the way the timer would. */
const copy = (source, n = 1) =>
  act(async () => {
    for (let i = 0; i < n; i += 1) source.step();
  });

test('the run reaches the tray: icon, title and tooltip follow it', async () => {
  const { source, item } = await mount();

  assert.equal(item().options.icon, 'externaldrive.fill', 'idle');
  assert.match(item().options.tooltip, /idle/);
  assert.equal(item().options.title, null, 'no percentage while idle');

  await act(async () => source.start());
  await copy(source, 1);
  assert.equal(item().options.icon, 'arrow.triangle.2.circlepath');
  assert.equal(item().options.title, '17%', '1 of 6');
  assert.match(item().options.tooltip, /1 of 6/);
});

test('a conflict is the badge, the attention flag and the icon at once', async () => {
  const { app, source, item } = await mount();

  await act(async () => source.start());
  assert.equal(item().options.attention, false);
  assert.equal(app.badges.at(-1), null, 'nothing to count yet');

  await copy(source, 2); // conflictsAt: [2, 4]
  assert.equal(app.badges.at(-1), '1');
  assert.equal(item().options.attention, true);
  assert.equal(item().options.icon, 'exclamationmark.triangle.fill');
  assert.equal(item().options.attentionIcon, 'exclamationmark.triangle.fill');

  await copy(source, 2);
  assert.equal(app.badges.at(-1), '2');

  // Resolving them puts all three back — attention you have already been
  // given is attention spent. Through the tray menu, because that is the
  // surface this example is about; the window's own buttons are the same
  // state either way.
  assert.match(item().options.menu[2].label, /^Keep mine for 2 files$/);
  await act(async () => item().options.menu[2].onSelect());
  assert.equal(app.badges.at(-1), null);
  assert.equal(item().options.attention, false);
  // back to the *running* icon, not the idle one: the run did not stop, it
  // stopped needing anything
  assert.equal(item().options.icon, 'arrow.triangle.2.circlepath');
});

test('the tray menu and the launcher quicklist are one items array', async () => {
  const { app, source } = await mount();
  const labels = (items) =>
    items.map((i) => i.label ?? (i.type === 'separator' ? '—' : ''));

  const quicklist = app.dockMenus.at(-1);
  assert.deepEqual(labels(quicklist), [
    'Back up now',
    '—',
    'Nothing needs you',
  ]);
  // the tray's is the same array with Quit on the end
  assert.deepEqual(labels(app.items.at(-1).options.menu), [
    ...labels(quicklist),
    '—',
    'Quit',
  ]);

  // and both follow the run
  await act(async () => source.start());
  await copy(source, 1);
  assert.equal(app.dockMenus.at(-1)[0].label, 'Pause backup');
  assert.equal(app.items.at(-1).options.menu[0].label, 'Pause backup');
});

test('picking "Back up now" from the tray menu starts the run', async () => {
  const { app, item } = await mount();
  await act(async () => item().options.menu[0].onSelect());
  assert.equal(app.items.at(-1).options.menu[0].label, 'Pause backup');
});

test('Quit from the tray menu runs the callback the app was given', async () => {
  let quit = 0;
  const { item } = await mount({ onQuit: () => quit++ });
  await act(async () => item().options.menu.at(-1).onSelect());
  assert.equal(quit, 1);
});

test('the finished banner carries actions because this rung has them', async () => {
  const { app, source } = await mount();
  await act(async () => source.start());
  await copy(source, 6);

  assert.equal(app.banners.length, 1, 'one banner, at the end');
  const banner = app.banners[0];
  assert.equal(banner.summary, 'Backup finished');
  assert.match(banner.body, /6 files/);
  // `features.actions` is true on a centre, so the button is offered
  assert.deepEqual(
    banner.actions.map((a) => a.key),
    ['show'],
  );
});

test('a desktop with no tray disables the setting rather than the app', async () => {
  // A plain mock has no `createStatusItem`, and `offTheDesktopBus()` means
  // the freedesktop rung finds no watcher either: no tray, by both routes.
  const { app, view } = await mount({ app: createMockApp() });

  assert.equal(app.items, undefined, 'nothing tried to make a status item');
  assert.ok(view.windowNode?.isWindow, 'the window is the whole app');
  // The prediction, not the measurement, is what greys the row out — and it
  // is still rendered, because a panel that starts later flips it back.
  assert.ok(
    screen.queryByText('Show tray icon'),
    'the setting is on screen, off',
  );
  assert.ok(
    screen.queryByText(/no tray took the icon/),
    'and the footer says which fact it is: absent, not refused',
  );
});

test('the pane reports a feature map per capability, not one boolean', async () => {
  await mount();

  // Three cards, one per `CAPABILITIES` entry, each naming the *mechanism*
  // that answered. On this app every rung is the cocoa one.
  for (const name of ['notifications', 'tray', 'launcher']) {
    assert.ok(screen.queryByText(name, { exact: true }), `${name} card`);
  }
  assert.equal(screen.getAllByText('cocoa', { exact: true }).length, 3);

  // And the half that is easy to forget: what each rung honestly *cannot*
  // do. A status item has modifiers on a click and no scroll; `NSDockTile`
  // has a badge and no progress bar.
  assert.ok(screen.queryByText('✓ clickModifiers', { exact: true }));
  assert.ok(screen.queryByText('✗ scroll', { exact: true }));
  assert.ok(screen.queryByText('✓ badge', { exact: true }));
  assert.ok(screen.queryByText('✗ progress', { exact: true }));
});
