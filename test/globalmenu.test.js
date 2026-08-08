// The global menu, end to end: a React tree, a broker, and a panel.
//
// `test/dbusmenu.test.js` proves the serialiser in isolation. This one proves
// the thing an app author actually gets — that `<MenuBar menus={…}/>` with no
// other code stops drawing when a panel appears, that the panel can walk the
// menu and activate a row, and that all of it goes back into the window when
// the panel exits.

import assert from 'node:assert';
import { describe, test } from 'node:test';
import React from 'react';

import { _resetBusState, busRefs, sessionBus } from '../src/bus.js';
import { createRoot } from '../src/index.js';
import { GlobalMenuExport, REGISTRAR_NAME } from '../src/globalmenu.js';
import { createMockApp } from './helpers/mock-app.js';
import { fakeRegistrar } from './helpers/fake-registrar.js';
import { transportAvailable, until, withBus } from './helpers/with-bus.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const h = React.createElement;

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

const MENUS = (over = {}) => [
  {
    label: 'File',
    items: [
      { label: 'New', shortcut: [['Control', 'N']], onSelect: over.onNew },
      { type: 'separator' },
      { label: 'Save', enabled: over.canSave ?? true },
      ...(over.extra ? [{ label: 'Quit' }] : []),
    ],
  },
  {
    label: 'View',
    items: [
      { label: 'Wrap', toggleType: 'checkmark', toggleState: over.wrap ?? 0 },
    ],
  },
];

/**
 * Mount a `<MenuBar>` in a window, hand back the knobs a test needs.
 *
 * `barIsDrawn()` reads the actual node tree rather than a flag: the assertion
 * that matters is whether anything is on screen, and a component that returned
 * null for the wrong reason would still pass a check on `exported`.
 */
async function mountBar(props = {}, menus = MENUS(), { dialsBus = true } = {}) {
  const { MenuBar } = await import('../src/index.js');
  const app = createMockApp();
  const root = await createRoot({ app });
  const render = (m, p = {}) =>
    root.render(
      h(
        'window',
        { width: 400, height: 200 },
        h(MenuBar, { menus: m, ...props, ...p }),
      ),
    );
  render(menus);
  await tick();
  // Wait for the menu to have *taken* the bus before doing anything else.
  // Unmounting mid-acquire leaves a connection nobody is holding while the
  // harness closes the broker under it, and the leftover handshake keeps the
  // process alive for the broker's 30 s timeout. It is also the assertion
  // that the feature dialled at all.
  if (dialsBus) {
    await until(() => busRefs('session') === 1, 'the menu to acquire the bus');
  }
  const wnd = app.windows[0];
  return {
    app,
    root,
    wnd,
    render,
    xid: wnd.id,
    /**
     * Unmount, and wait for the export to actually be gone.
     *
     * React's effect cleanup returns synchronously, so the D-Bus half of it —
     * UnregisterWindow, unexport, RemoveMatch, release — runs detached
     * afterwards. Letting the harness close the broker under that produces an
     * ECONNRESET from a socket nobody is waiting on any more. Waiting on the
     * ref count is also the assertion that the menu does not leak a bus ref.
     */
    async unmount() {
      await root.unmount();
      await until(
        () => busRefs('session') === 0,
        'the menu to release the bus',
      );
    },
    /** Bar items are the `<box>` children of the MenuBar's own box. */
    barIsDrawn() {
      const node = wnd._reactX11Node;
      const bar = node?.children?.[0];
      return Boolean(bar?.children?.length);
    },
    // Only the two this feature owns: the renderer sets XdndAware on every
    // window, and counting that would make the "nothing was written"
    // assertions pass for the wrong reason.
    propertyCalls: () =>
      wnd.calls.filter((c) => String(c[1]).startsWith('_KDE_NET_WM_APPMENU')),
  };
}

describe('the global menu', { concurrency: 1, ...needsBroker }, () => {
  test('with no panel running, the bar draws itself', async () => {
    await withBus(async () => {
      const bar = await mountBar();
      // The registrar name has no owner on this broker at all, which is the
      // ssh / bare-startx / stock-GNOME case.
      await tick();
      await tick();
      assert.equal(bar.barIsDrawn(), true);
      assert.deepEqual(bar.propertyCalls(), []);
      await bar.unmount();
    });
  });

  test('a panel takes the menu, and the window stops drawing one', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();

      await until(() => panel.windows.size === 1, 'the window to register');
      assert.deepEqual(panel.calls[0].slice(0, 2), ['RegisterWindow', bar.xid]);
      assert.equal(
        panel.calls.filter((c) => c[0] === 'RegisterWindow').length,
        1,
        'registered once',
      );

      // `exported` is only true once RegisterWindow has *answered*, so the bar
      // disappears on evidence rather than on a guess.
      await until(() => !bar.barIsDrawn(), 'the drawn bar to go away');

      await panel.stop();
      await bar.unmount();
    });
  });

  test('the panel can walk the whole menu', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => panel.windows.size === 1, 'registration');

      const menu = await panel.readMenu();
      assert.equal(menu.id, 0);
      assert.deepEqual(
        menu.children.map((c) => c.props.label),
        ['File', 'View'],
      );
      const file = menu.children[0];
      assert.equal(file.props['children-display'], 'submenu');
      assert.deepEqual(
        file.children.map((c) => c.props.label ?? c.props.type),
        ['New', 'separator', 'Save'],
      );
      assert.deepEqual(file.children[0].props.shortcut, [['Control', 'N']]);

      await panel.stop();
      await bar.unmount();
    });
  });

  test('the four interface properties are served', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => panel.windows.size === 1, 'registration');

      // Some panels gate on these, so an absent one is an empty menu.
      assert.equal(await panel.interfaceProperty('Version'), 3);
      assert.equal(await panel.interfaceProperty('Status'), 'normal');
      assert.equal(await panel.interfaceProperty('TextDirection'), 'ltr');
      assert.deepEqual(await panel.interfaceProperty('IconThemePath'), []);

      await panel.stop();
      await bar.unmount();
    });
  });

  test('clicking in the panel runs the app’s handlers', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const picked = [];
      const bar = await mountBar(
        { onSelect: (item) => picked.push(`bar:${item.label}`) },
        MENUS({ onNew: (item) => picked.push(`item:${item.label}`) }),
      );
      await until(() => panel.windows.size === 1, 'registration');

      const menu = await panel.readMenu();
      const newItem = menu.children[0].children[0];
      await panel.click(newItem.id);
      await tick();

      // Both, and in that order — exactly what selecting in the drawn menu does.
      assert.deepEqual(picked, ['item:New', 'bar:New']);

      await panel.stop();
      await bar.unmount();
    });
  });

  test('a click from the panel produces exactly one property signal', async () => {
    await withBus(async (address) => {
      // The whole round trip on the real path: the panel activates a row, the
      // app's handler flips state, React re-renders, and the diff decides what
      // to say. Every render rebuilds this `menus` array, so `update()` runs
      // several times — only the one that actually changed something may put a
      // signal on the wire.
      const panel = await fakeRegistrar(address);
      let wrap = 0;
      const { MenuBar } = await import('../src/index.js');
      const app = createMockApp();
      const root = await createRoot({ app });
      const draw = () =>
        root.render(
          h(
            'window',
            { width: 400, height: 200 },
            h(MenuBar, {
              menus: [
                {
                  label: 'View',
                  items: [
                    {
                      label: 'Wrap',
                      toggleType: 'checkmark',
                      toggleState: wrap,
                      onSelect: () => {
                        wrap = wrap ? 0 : 1;
                        draw();
                      },
                    },
                  ],
                },
              ],
            }),
          ),
        );
      draw();
      await tick();
      await until(() => busRefs('session') === 1, 'the bus');
      await until(() => panel.windows.size === 1, 'registration');

      const menu = await panel.readMenu();
      const watch = await panel.watchSignals();
      await panel.click(menu.children[0].children[0].id);
      await until(() => watch.seen.length > 0, 'the property signal');
      // Let any further renders settle before counting.
      await tick();
      await tick();
      await new Promise((r) => setTimeout(r, 50));

      assert.deepEqual(
        watch.seen.map((s) => s[0]),
        ['ItemsPropertiesUpdated'],
        'one signal, and it is the cheap one',
      );

      await watch.stop();
      await panel.stop();
      await root.unmount();
      await until(() => busRefs('session') === 0, 'the bus to be released');
    });
  });

  test('a toggle flipping patches properties and does not bump the revision', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => panel.windows.size === 1, 'registration');

      const before = await panel.readMenu();
      const watch = await panel.watchSignals();

      bar.render(MENUS({ wrap: 1 }));
      await until(() => watch.seen.length > 0, 'a signal');
      await tick();

      assert.equal(watch.seen[0][0], 'ItemsPropertiesUpdated');
      const [, updated] = watch.seen[0];
      const wrapId = before.children[1].children[0].id;
      assert.deepEqual(updated, [[wrapId, { 'toggle-state': 1 }]]);

      // The revision is what a shell re-walks a subtree on. It must not move.
      const after = await panel.readMenu();
      assert.equal(after.revision, before.revision);

      await watch.stop();
      await panel.stop();
      await bar.unmount();
    });
  });

  test('adding a row bumps the revision and names the changed menu', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => panel.windows.size === 1, 'registration');

      const before = await panel.readMenu();
      const watch = await panel.watchSignals();

      bar.render(MENUS({ extra: true }));
      await until(() => watch.seen.length > 0, 'a signal');

      const [member, revision, parent] = watch.seen[0];
      assert.equal(member, 'LayoutUpdated');
      assert.equal(revision, before.revision + 1);
      // the File menu, not 0: the View menu did not change
      assert.equal(parent, before.children[0].id);

      const after = await panel.readMenu();
      assert.deepEqual(
        after.children[0].children.map((c) => c.props.label ?? c.props.type),
        ['New', 'separator', 'Save', 'Quit'],
      );

      await watch.stop();
      await panel.stop();
      await bar.unmount();
    });
  });

  test('AboutToShow answers false and reports, rather than lying', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const asked = [];
      const bar = await mountBar({ onSelect: () => {} });
      // the hook's own seam; MenuBar does not take one, so reach past it
      await until(() => panel.windows.size === 1, 'registration');

      const menu = await panel.readMenu();
      const needUpdate = await panel.aboutToShow(menu.children[0].id);
      // A `setState` here would not have rendered by the time this reply must
      // go out, so `true` would be a promise we cannot keep — the shell would
      // then GetLayout a subtree that has not been built and cache the old one.
      assert.equal(needUpdate, false);
      void asked;

      await panel.stop();
      await bar.unmount();
    });
  });

  test('the KDE window properties are set beside the registration', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => bar.propertyCalls().length >= 2, 'the X properties');

      const calls = bar.propertyCalls();
      const service = calls.find(
        (c) => c[1] === '_KDE_NET_WM_APPMENU_SERVICE_NAME',
      );
      const path = calls.find(
        (c) => c[1] === '_KDE_NET_WM_APPMENU_OBJECT_PATH',
      );
      assert.ok(service, 'the service-name property');
      assert.match(service[2], /^:\d+\.\d+$/); // our own unique name
      assert.equal(path[2], `/com/react_x11/menus/${bar.xid}`);
      // KDE writes and reads these as STRING/8, where ntk would default a
      // string property to UTF8_STRING.
      assert.deepEqual(service[3], { type: 'STRING', format: 8 });
      assert.deepEqual(path[3], { type: 'STRING', format: 8 });

      await panel.stop();
      await bar.unmount();
    });
  });

  test('concurrent syncs register the window once, not once each', async () => {
    await withBus(async (address) => {
      // Driven straight at the exporter, because the race needs several
      // `sync()`s in flight *before* the first finishes — `exported` only
      // turns true at the end of publish(), several awaits in, so an
      // unserialised version puts two publishes on the same window.
      const owner = new GlobalMenuExport({
        getMenus: () => MENUS(),
        target: { id: 0x4242 },
        onChange: () => {},
      });
      await owner.start(); // a bus, but no panel yet: nothing exported
      assert.equal(owner.exported, false);

      const panel = await fakeRegistrar(address);
      // the NameOwnerChanged one, plus three piled on top of it
      await Promise.all([owner.sync(), owner.sync(), owner.sync()]);
      await until(() => panel.windows.size === 1, 'registration');
      await tick();

      assert.equal(
        panel.calls.filter((c) => c[0] === 'RegisterWindow').length,
        1,
        'exactly one RegisterWindow',
      );

      await owner.stop();
      await panel.stop();
      await until(() => busRefs('session') === 0, 'the bus to be released');
    });
  });

  test('the panel exiting brings the bar back into the window', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => !bar.barIsDrawn(), 'the bar to be handed over');

      // A panel is exactly the kind of thing that gets restarted, which is why
      // the answer is followed rather than cached.
      await panel.stop();
      await until(() => bar.barIsDrawn(), 'the bar to come back');

      await bar.unmount();
    });
  });

  test('a panel starting later takes the menu without a re-render', async () => {
    await withBus(async (address) => {
      const bar = await mountBar();
      await tick();
      assert.equal(bar.barIsDrawn(), true);

      const panel = await fakeRegistrar(address);
      await until(() => panel.windows.size === 1, 'a late registration');
      await until(() => !bar.barIsDrawn(), 'the bar to be handed over');

      await panel.stop();
      await bar.unmount();
    });
  });

  test('unmounting unregisters and clears the window properties', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => panel.windows.size === 1, 'registration');

      await bar.unmount();
      await until(() => panel.windows.size === 0, 'the unregistration');
      await until(
        () =>
          bar.wnd.calls.some(
            (c) =>
              c[0] === 'deleteProperty' &&
              c[1] === '_KDE_NET_WM_APPMENU_SERVICE_NAME',
          ),
        'the service-name property to be deleted',
      );

      await panel.stop();
    });
  });

  test('globalMenu={false} keeps the bar in the window', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar({ globalMenu: false }, MENUS(), {
        dialsBus: false,
      });
      await tick();
      await tick();

      assert.equal(bar.barIsDrawn(), true);
      assert.equal(panel.windows.size, 0);
      assert.deepEqual(bar.propertyCalls(), []);

      await panel.stop();
      await bar.unmount();
    });
  });

  test('REACT_X11_NO_GLOBAL_MENU=1 turns it off process-wide', async () => {
    await withBus(async (address) => {
      const saved = process.env.REACT_X11_NO_GLOBAL_MENU;
      process.env.REACT_X11_NO_GLOBAL_MENU = '1';
      try {
        const panel = await fakeRegistrar(address);
        const bar = await mountBar(undefined, MENUS(), { dialsBus: false });
        await tick();
        await tick();
        assert.equal(bar.barIsDrawn(), true);
        assert.equal(panel.windows.size, 0);
        assert.equal(busRefs('session'), 0, 'the bus is not even dialled');
        await panel.stop();
        await bar.unmount();
      } finally {
        if (saved === undefined) delete process.env.REACT_X11_NO_GLOBAL_MENU;
        else process.env.REACT_X11_NO_GLOBAL_MENU = saved;
      }
    });
  });

  test('registrar calls carry NO_AUTO_START, so a dead panel is not respawned', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const bar = await mountBar();
      await until(() => panel.windows.size === 1, 'registration');
      await bar.unmount();
      await until(() => panel.windows.size === 0, 'the unregistration');

      // Invisible from the arguments, and the difference between tidying up
      // and launching Ubuntu's `appmenu-registrar` from a `.service` file —
      // which then owns the name with nothing drawing the menus it collects.
      // Observed for real before this flag was added; see globalmenu.js.
      assert.deepEqual(panel.flags, [
        ['RegisterWindow', 2],
        ['UnregisterWindow', 2],
      ]);

      await panel.stop();
    });
  });

  test('with no bus at all, the bar draws and nothing is attempted', async () => {
    // react-x11's flagship persona: an ssh session, a bare startx, a
    // container, CI. "No bus" is a first-class configuration rather than a
    // degraded one (docs/dbus.md), so this must be indistinguishable from a
    // desktop that simply has no panel — no throw, no log, no missing menu.
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    const savedRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.DBUS_SESSION_BUS_ADDRESS =
      'unix:path=/nonexistent/react-x11-no-such-bus';
    delete process.env.XDG_RUNTIME_DIR;
    _resetBusState();
    try {
      const bar = await mountBar(undefined, MENUS(), { dialsBus: false });
      await tick();
      await tick();
      assert.equal(bar.barIsDrawn(), true);
      assert.deepEqual(bar.propertyCalls(), []);
      assert.equal(busRefs('session'), 0);
      await bar.root.unmount();
    } finally {
      if (saved === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
      else process.env.DBUS_SESSION_BUS_ADDRESS = saved;
      if (savedRuntime !== undefined)
        process.env.XDG_RUNTIME_DIR = savedRuntime;
      _resetBusState();
    }
  });

  test('stopping while the X properties are being written undoes them', async () => {
    await withBus(async (address) => {
      // Plasma prefers the KDE properties to the registrar, so a window left
      // advertising an object path that is then unexported shows an empty
      // menu for as long as it lives — the exact opposite of what they are
      // for. `setProperty` is held open so the unmount lands *inside*
      // `setWindowProperties`, which is the window `stop()` has to wait out
      // rather than race.
      const panel = await fakeRegistrar(address);
      const calls = [];
      const target = {
        id: 0x99,
        setProperty: async (name) => {
          await new Promise((r) => setTimeout(r, 60));
          calls.push(['set', name]);
        },
        deleteProperty: async (name) => {
          calls.push(['delete', name]);
        },
      };
      const owner = new GlobalMenuExport({
        getMenus: () => MENUS(),
        target,
        onChange: () => {},
      });

      const started = owner.start();
      await until(() => calls.length > 0, 'the first property write');
      await owner.stop();
      await started;

      // Whatever the interleaving, the window must not be left carrying a
      // property: every set is followed by its delete.
      const sets = calls.filter((c) => c[0] === 'set').length;
      const deletes = calls.filter((c) => c[0] === 'delete').length;
      assert.ok(deletes >= sets, `${sets} set, only ${deletes} deleted`);
      assert.equal(calls.at(-1)?.[0], 'delete', 'the last word is a delete');

      await panel.stop();
      await until(() => busRefs('session') === 0, 'the bus to be released');
    });
  });

  test('a watch that resolves after stop() installs nothing', async () => {
    await withBus(async (address) => {
      const panel = await fakeRegistrar(address);
      const owner = new GlobalMenuExport({
        getMenus: () => MENUS(),
        target: { id: 0x99 },
        onChange: () => {},
      });
      await owner.start();
      await owner.stop();

      // The real sequence is an unmount inside the AddMatch round trip, which
      // is a few milliseconds wide and cannot be hit reliably from outside —
      // so the guard is exercised where it lives. Without it, `teardown()`
      // has already run and found `subscription` null, and this call installs
      // a match rule and a `NameOwnerChanged` listener that nothing will ever
      // remove: the daemon keeps waking the process, and the listener pins
      // this exporter, its snapshot and every item's `onSelect` for good.
      const ref = await sessionBus();
      owner.ref = ref;
      await owner.watchRegistrar();
      assert.equal(owner.subscription, null, 'no match rule installed');
      assert.equal(owner.onOwnerChanged, undefined, 'no listener installed');

      await ref.release();
      await panel.stop();
      await until(() => busRefs('session') === 0, 'the bus to be released');
    });
  });

  test('a registrar that refuses the registration leaves nothing behind', async () => {
    await withBus(async (address) => {
      // The bar is drawn either way, which is the visible part. The part that
      // is not visible is whether the attempt left a bus reference, a match
      // rule and an orphan `com.canonical.dbusmenu` object behind for a
      // registration that never happened — so `start()` has to be able to see
      // that the sync failed, which means `sync()` must not swallow.
      const panel = await fakeRegistrar(address, { refuseRegister: true });
      // `dialsBus: false` because the teardown that follows the refusal can
      // release the ref before a poll for "it acquired one" ever sees it —
      // the refused call below is the better evidence that it dialled.
      const bar = await mountBar(undefined, MENUS(), { dialsBus: false });
      await until(() => panel.calls.length > 0, 'the refused RegisterWindow');
      await until(() => busRefs('session') === 0, 'the bus to be let go');

      assert.equal(bar.barIsDrawn(), true, 'the bar stays in the window');
      assert.deepEqual(
        bar.propertyCalls(),
        [],
        'and nothing was written to it',
      );

      await panel.stop();
      await bar.root.unmount();
    });
  });

  test('the registrar name is the one panels actually own', () => {
    // Spelled out because a typo here is a feature that silently never fires.
    assert.equal(REGISTRAR_NAME, 'com.canonical.AppMenu.Registrar');
  });
});
