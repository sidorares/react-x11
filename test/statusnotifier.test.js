// The freedesktop tray, end to end: a React tree, a bus, and a panel.
//
// `test/dbusmenu.test.js` proves the serialiser in isolation and
// `test/globalmenu.test.js` proves the panel-menu half of the same exporter.
// This one proves the thing an app author gets — that `useTray({…})` puts an
// icon in a tray that exists, reports honestly when there is not one, lets a
// host read every property and walk the menu, and takes the icon away again
// on unmount.

import assert from 'node:assert';
import { describe, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { useTray } from '../src/trayhooks.js';
import {
  StatusNotifierItem,
  _resetItemIndex,
  toPixmapArray,
} from '../src/statusnotifier.js';
import { registerApplication } from '../src/application.js';
import { _resetApplicationState } from '../src/application.js';
import { setScreensForTests } from '../src/screens.js';
import { createMockApp } from './helpers/mock-app.js';
import { fakeWatcher } from './helpers/fake-watcher.js';
import {
  offTheDesktopBus,
  transportAvailable,
  until,
  withBus,
  withNoBus,
} from './helpers/with-bus.js';

offTheDesktopBus();

const tick = () => new Promise((resolve) => setImmediate(resolve));
const h = React.createElement;

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const MENU = (over = {}) => [
  { label: 'Open', onSelect: over.onOpen },
  { type: 'separator' },
  { label: 'Wrap', toggleType: 'checkmark', toggleState: over.wrap ?? 0 },
  {
    label: 'Recent',
    items: [{ label: 'notes.md', onSelect: over.onRecent }],
  },
  { label: 'Quit', onSelect: over.onQuit },
];

/**
 * Mount a `useTray()` in a window and hand back the knobs a test needs.
 *
 * `display` is the screen a click is read against: `scale`, the `monitors`
 * in device pixels, and `pointer`, where `QueryPointer` says the pointer is
 * (device pixels) — left out, the connection has no `QueryPointer` at all.
 */
async function mountTray(options = {}, display = {}) {
  const app = createMockApp();
  if (display.monitors) setScreensForTests(app, { monitors: display.monitors });
  const pointer = { at: display.pointer, queries: 0 };
  if (display.pointer !== undefined) {
    app.X.QueryPointer = (wid, cb) => {
      pointer.queries += 1;
      const { x, y } = pointer.at;
      cb(null, { root: wid, child: 0, rootX: x, rootY: y, sameScreen: 1 });
    };
  }
  const root = await createRoot({ app, scale: display.scale });
  const seen = { available: [], error: [] };
  let setOptions;

  function Probe() {
    const [opts, set] = React.useState(options);
    setOptions = set;
    const state = useTray(opts);
    seen.available.push(state.available);
    seen.error.push(state.error);
    seen.last = state;
    return null;
  }

  root.render(h('window', { width: 100, height: 100 }, h(Probe)));
  await tick();
  return {
    root,
    pointer,
    seen,
    state: () => seen.last,
    setOptions: (next) => {
      setOptions(next);
      return tick();
    },
    unmount: () => root.render(null),
  };
}

describe('the freedesktop tray', () => {
  test('ARGB32 is big-endian: a pixel is A R G B, not the buffer order', () => {
    // One opaque pure-red pixel as straight RGBA.
    const image = { width: 1, height: 1, data: [255, 0, 0, 255] };
    const [[width, height, bytes]] = toPixmapArray(image);
    assert.equal(width, 1);
    assert.equal(height, 1);
    // A=255, R=255, G=0, B=0 — the failure mode this guards is a tray icon
    // that is recognisably the right shape in the wrong colours.
    assert.deepEqual([...bytes], [255, 255, 0, 0]);
  });

  test('no image is no pixmap, rather than a zero-sized one', () => {
    assert.deepEqual(toPixmapArray(null), []);
    assert.deepEqual(toPixmapArray({ width: 0, height: 0, data: [] }), []);
  });

  test('with no bus there is no tray, and nothing is thrown', async () => {
    await withNoBus(async () => {
      const item = new StatusNotifierItem({ getOptions: () => ({}) });
      assert.equal(await item.start(), false);
      await item.stop();
    });
  });

  test(
    'an icon registers, and a host can read every property off it',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traytest' });
        const host = await fakeWatcher(address);
        const tray = await mountTray({
          icon: 'mail-unread',
          title: 'Inbox',
          tooltip: '3 unread',
          menu: MENU(),
        });

        await until(() => host.items.length === 1, 'the item to register');

        // The **path** form, sender-attributed — see `statusnotifier.js`.
        const [[member, service]] = host.calls;
        assert.equal(member, 'RegisterStatusNotifierItem');
        assert.match(service, /^\/StatusNotifierItem\//);

        const props = await host.properties();
        assert.equal(props.Id, 'com.example.traytest');
        assert.equal(props.Title, 'Inbox');
        assert.equal(props.Status, 'Active');
        assert.equal(props.IconName, 'mail-unread');
        assert.equal(props.Category, 'ApplicationStatus');
        // A menu and no onClick: the click *is* the menu.
        assert.equal(props.ItemIsMenu, true);
        assert.equal(props.Menu, `${service}/Menu`);
        assert.deepEqual(props.ToolTip, ['', [], '3 unread', '']);

        await until(
          () => tray.state()?.available === true,
          'available to settle',
        );
        assert.equal(tray.state().backend, 'statusnotifier');
        assert.equal(tray.state().error, null);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'the features report what this rung genuinely cannot do',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.trayfeat' });
        const host = await fakeWatcher(address);
        const tray = await mountTray({ icon: 'mail-unread', menu: MENU() });
        await until(() => tray.state()?.available === true, 'available');

        const { features } = tray.state();
        assert.equal(features.menu, true);
        assert.equal(features.attention, true);
        assert.equal(features.scroll, true);
        // The protocol carries no item rect and no modifier state. An app
        // that dims a shift-click affordance reads exactly this.
        assert.equal(features.clickRect, false);
        assert.equal(features.clickModifiers, false);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'a host walks the menu and activating a row runs the handler',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traymenu' });
        const host = await fakeWatcher(address);
        const picked = [];
        const tray = await mountTray({
          icon: 'mail-unread',
          menu: MENU({
            onOpen: () => picked.push('open'),
            onRecent: () => picked.push('notes.md'),
          }),
        });
        await until(() => host.items.length === 1, 'the item to register');

        const menu = await host.readMenu();
        assert.deepEqual(
          menu.children.map((c) => c.props.label ?? c.props.type),
          ['Open', 'separator', 'Wrap', 'Recent', 'Quit'],
        );
        // The submenu is walked in the same pass, as a panel does.
        const recent = menu.children[3];
        assert.equal(recent.props['children-display'], 'submenu');
        assert.deepEqual(
          recent.children.map((c) => c.props.label),
          ['notes.md'],
        );

        await host.click(menu.children[0].id);
        await until(() => picked.length === 1, 'the handler to run');
        assert.deepEqual(picked, ['open']);

        // …including one nested a level down.
        await host.click(recent.children[0].id);
        await until(() => picked.length === 2, 'the nested handler to run');
        assert.deepEqual(picked, ['open', 'notes.md']);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'a click on the icon reports the button and the position it has',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.trayclick' });
        const host = await fakeWatcher(address);
        const clicks = [];
        const tray = await mountTray({
          icon: 'mail-unread',
          onClick: (ev) => clicks.push(ev),
        });
        await until(() => host.items.length === 1, 'the item to register');

        // No menu and an onClick: the host should send Activate, not open one.
        assert.equal(await host.property('ItemIsMenu'), false);

        await host.activate(42, 99);
        await until(() => clicks.length === 1, 'the click to arrive');
        const [ev] = clicks;
        assert.equal(ev.button, 'left');
        assert.equal(ev.x, 42);
        assert.equal(ev.y, 99);
        // Reported as zero rather than invented: the protocol has neither.
        assert.equal(ev.width, 0);
        assert.equal(ev.clickModifiers, undefined);
        assert.equal(ev.shift, false);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  // A 2560x1600 panel at scale 2: 1280x800 logical pixels.
  const PANEL = { x: 0, y: 0, width: 2560, height: 1600, primary: true };

  test(
    'a click in device pixels reaches onClick in logical ones',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traydevice' });
        const host = await fakeWatcher(address);
        const clicks = [];
        // No QueryPointer on this connection: the monitor has to settle it.
        const tray = await mountTray(
          { icon: 'mail-unread', onClick: (ev) => clicks.push(ev) },
          { scale: 2, monitors: [PANEL] },
        );
        await until(() => host.items.length === 1, 'the item to register');

        // Plasma's bottom-right tray, in X root coordinates. Read as logical
        // pixels the point would be (5000, 3160), which no monitor holds.
        await host.activate(2500, 1580);
        await until(() => clicks.length === 1, 'the click to arrive');
        assert.equal(clicks[0].x, 1250);
        assert.equal(clicks[0].y, 790);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'where both readings land on a monitor, the pointer picks',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traypointer' });
        const host = await fakeWatcher(address);
        const clicks = [];
        const tray = await mountTray(
          { icon: 'mail-unread', onClick: (ev) => clicks.push(ev) },
          { scale: 2, monitors: [PANEL], pointer: { x: 2500, y: 24 } },
        );
        await until(() => host.items.length === 1, 'the item to register');

        // A GTK panel's top-right tray, in the panel's own logical pixels.
        // Read as X root coordinates (1250, 12) is on the screen too, half-way
        // along the top, so only the pointer can say which it was.
        await host.activate(1250, 12);
        await until(() => clicks.length === 1, 'the first click');
        assert.deepEqual([clicks[0].x, clicks[0].y], [1250, 12]);

        // The same numbers from a device-pixel host, the pointer on them.
        tray.pointer.at = { x: 1251, y: 13 };
        await host.activate(1250, 12);
        await until(() => clicks.length === 2, 'the second click');
        assert.deepEqual([clicks[1].x, clicks[1].y], [625, 6]);
        assert.equal(tray.pointer.queries, 2);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'with the pointer on neither reading, the numbers are taken as sent',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.trayassent' });
        const host = await fakeWatcher(address);
        const clicks = [];
        // A click from the keyboard, or one under XWayland, which is told
        // nothing of a pointer over a Wayland panel: it is somewhere else.
        const tray = await mountTray(
          { icon: 'mail-unread', onClick: (ev) => clicks.push(ev) },
          { scale: 2, monitors: [PANEL], pointer: { x: 300, y: 1400 } },
        );
        await until(() => host.items.length === 1, 'the item to register');

        await host.activate(1250, 12);
        await until(() => clicks.length === 1, 'the click to arrive');
        assert.deepEqual([clicks[0].x, clicks[0].y], [1250, 12]);
        assert.equal(tray.pointer.queries, 1);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'a changed field emits its own signal and not the others',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traysignal' });
        const host = await fakeWatcher(address);
        const tray = await mountTray({
          icon: 'mail-unread',
          title: 'Inbox',
          tooltip: 'nothing new',
          menu: MENU(),
        });
        await until(() => host.items.length === 1, 'the item to register');

        const watch = await host.watchSignals();
        await tray.setOptions({
          icon: 'mail-unread',
          title: 'Inbox',
          tooltip: '3 unread',
          menu: MENU(),
        });
        await until(() => watch.seen.length > 0, 'a signal');

        // Only the tooltip moved. Emitting all six would make a host re-read
        // every property for one string — see `StatusNotifierItem.update`.
        assert.deepEqual(
          watch.seen.map(([member]) => member),
          ['NewToolTip'],
        );
        assert.equal(
          await host.property('ToolTip').then((t) => t[2]),
          '3 unread',
        );

        await watch.stop();
        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'visible:false is Passive, and attention is NeedsAttention',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traystatus' });
        const host = await fakeWatcher(address);
        const tray = await mountTray({ icon: 'mail-unread' });
        await until(() => host.items.length === 1, 'the item to register');
        assert.equal(await host.property('Status'), 'Active');

        await tray.setOptions({ icon: 'mail-unread', attention: true });
        await until(
          async () => (await host.property('Status')) === 'NeedsAttention',
          'NeedsAttention',
        );

        await tray.setOptions({ icon: 'mail-unread', visible: false });
        await until(
          async () => (await host.property('Status')) === 'Passive',
          'Passive',
        );

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test('unmounting takes the icon out of the tray', needsBroker, async () => {
    await withBus(async (address) => {
      _resetItemIndex();
      _resetApplicationState();
      await registerApplication({ appId: 'com.example.trayunmount' });
      const host = await fakeWatcher(address);
      const tray = await mountTray({ icon: 'mail-unread', menu: MENU() });
      await until(() => host.items.length === 1, 'the item to register');
      const target = host.items[0];

      const watch = await host.watchSignals(target);
      await tray.unmount();

      // `Passive` goes out **before** the object does — the icon has to leave
      // the panel, and un-exporting alone tells a host nothing, since our bus
      // name is the app's and outlives any one icon.
      await until(
        () => watch.seen.some(([m, v]) => m === 'NewStatus' && v === 'Passive'),
        'the Passive announcement',
      );
      await watch.stop();

      // Then the object goes: a host that kept the reference gets an error
      // rather than a stale icon that still answers. Polled rather than
      // ticked, because the announcement above deliberately holds the export
      // open for a moment.
      await until(
        () =>
          host.properties(target).then(
            () => false,
            () => true,
          ),
        'the item to stop answering',
      );
    });
  });

  test(
    'switching the icon off and on again is one icon, not two',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.traytoggle' });
        const host = await fakeWatcher(address);
        const tray = await mountTray({ icon: 'mail-unread', menu: MENU() });
        await until(() => host.items.length === 1, 'the item to register');
        const firstPath = host.calls[0][1];

        const watch = await host.watchSignals();

        // Off. There is no `UnregisterStatusNotifierItem`, and our bus name
        // is the app's shared one and does not go away — so `Passive` is the
        // only thing that takes the icon off the panel.
        await tray.setOptions(null);
        await until(
          () =>
            watch.seen.some(([m, v]) => m === 'NewStatus' && v === 'Passive'),
          'the Passive announcement',
        );

        // On again. The **same** `sender@path`: a fresh one would read to the
        // host as a second tray icon appearing beside the first, which is the
        // bug this test exists for.
        await tray.setOptions({ icon: 'mail-unread', menu: MENU() });
        await until(() => host.calls.length === 2, 're-registration');
        assert.equal(host.calls[1][1], firstPath, 'same path on the way back');
        assert.equal(host.items.length, 2, 'the fake host records both calls');

        // And it must announce itself, because a host that already knew this
        // id answers a repeat registration with a reset and no property read
        // — so the `Passive` it was told on the way out is still what it
        // believes until we say otherwise.
        await until(
          () =>
            watch.seen.some(([m, v]) => m === 'NewStatus' && v === 'Active'),
          'the Active announcement on the way back',
        );
        assert.equal(await host.property('Status', host.items[1]), 'Active');

        await watch.stop();
        await tray.unmount();
        await host.stop();
      });
    },
  );

  test(
    'a watcher that refuses the registration is reported, not thrown',
    needsBroker,
    async () => {
      await withBus(async (address) => {
        _resetItemIndex();
        _resetApplicationState();
        await registerApplication({ appId: 'com.example.trayrefuse' });
        const host = await fakeWatcher(address, { refuseRegister: true });
        const tray = await mountTray({ icon: 'mail-unread' });

        await until(() => host.calls.length === 1, 'the attempt');
        await until(() => tray.state()?.error != null, 'the error to surface');

        // "There is a tray and it refused me" is a different fact from "this
        // desktop has no tray", and only one of them has a fix.
        assert.equal(tray.state().available, false);
        assert.ok(tray.state().error instanceof Error);

        await tray.unmount();
        await host.stop();
      });
    },
  );

  test('no watcher on the bus is no tray, silently', needsBroker, async () => {
    await withBus(async () => {
      _resetItemIndex();
      _resetApplicationState();
      await registerApplication({ appId: 'com.example.traynone' });
      // A bus, but nothing hosting a tray on it — a stock GNOME session
      // with no AppIndicator extension, which is the common case.
      const tray = await mountTray({ icon: 'mail-unread' });
      await tick();
      await tick();
      assert.equal(tray.state().available, false);
      assert.equal(tray.state().backend, null);
      assert.equal(tray.state().error, null);
      await tray.unmount();
    });
  });
});
