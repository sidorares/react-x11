// A `<popup grab>` is dismissed when the user goes to another application.
//
// A press outside it was the only dismissal, and a press does not cover the
// switch: on Cocoa the grab redirects presses between this app's windows and
// nothing else, so a click in another application or ⌘-Tab left the menu — an
// NSPanel at the pop-up-menu level — drawn over the app the user switched to;
// on X, alt-tab is the window manager's keyboard grab and reaches the menu as
// nothing. `Select`, `ContextMenu` and `MenuBar` each listened to the owner
// window's focus to cover it, and a menu built straight on `<popup grab
// onDismiss>` did not. The window it hangs from losing the keyboard is now
// an `onDismiss` with `reason: 'focus'`, in core, for every backend.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot } from '../src/index.js';
import { createMockApp, flushFrames } from './helpers/mock-app.js';
import { cleanupCocoa, mountCocoa, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

async function mount(app, element) {
  const root = await createRoot({ app });
  await new Promise((resolve) => root.render(element, resolve));
  await tick();
  await tick();
  return root;
}

/** A window with a trigger and, while `open`, a popup hanging off it. */
function Menu({ popup, dismissals, ownerProps }) {
  const [open, setOpen] = React.useState(true);
  const trigger = React.useRef(null);
  return h(
    'window',
    { width: 300, height: 200, ...ownerProps },
    h('box', { ref: trigger, style: { width: 80, height: 24 } }),
    open &&
      h(
        'popup',
        {
          anchor: { to: trigger, placement: 'bottom' },
          onDismiss: (ev) => {
            dismissals.push(ev.reason);
            if (popup.keepOpen !== true) setOpen(false);
          },
          ...popup,
        },
        h('box', { style: { width: 120, height: 60 } }),
      ),
  );
}

/** The mock app's popup windows that are still up. */
const livePopups = (app) =>
  app.windows.filter((w) => w._reactX11Node?.isPopup && !w.destroyed);

test('the owner window losing the keyboard dismisses a grabbing popup', async () => {
  const app = createMockApp();
  const dismissals = [];
  const root = await mount(app, h(Menu, { popup: { grab: true }, dismissals }));
  const [owner] = app.windows;
  assert.strictEqual(livePopups(app).length, 1, 'the premise: it is up');

  // alt-tab, ⌘-Tab, a click in another application: all a backend says
  owner.emit('blur', {});
  await tick();

  assert.deepStrictEqual(dismissals, ['focus'], 'one dismissal, saying why');
  assert.strictEqual(livePopups(app).length, 0, 'and the app closed it');

  // gone with it: a later blur reaches no listener
  owner.emit('focus', {});
  owner.emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, ['focus']);
  await root.unmount();
});

test('a press outside still reports itself as a press', async () => {
  const app = createMockApp();
  const dismissals = [];
  const root = await mount(app, h(Menu, { popup: { grab: true }, dismissals }));
  const [popup] = livePopups(app);
  popup.emit('mousedown', { x: -5, y: -5, keycode: 1, buttons: 0 });
  await tick();
  assert.deepStrictEqual(dismissals, ['press']);
  await root.unmount();
});

test('a popup without a grab is not a menu, and is left alone', async () => {
  const app = createMockApp();
  const dismissals = [];
  const root = await mount(
    app,
    h(Menu, { popup: { grab: false }, dismissals }),
  );
  const [owner] = app.windows;
  owner.emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, [], 'a tooltip is not dismissed');
  assert.strictEqual(livePopups(app).length, 1);
  await root.unmount();
});

test('the handler decides: one that keeps the popup hears each switch', async () => {
  const app = createMockApp();
  const dismissals = [];
  const root = await mount(
    app,
    h(Menu, { popup: { grab: true, keepOpen: true }, dismissals }),
  );
  const [owner] = app.windows;
  owner.emit('blur', {});
  await tick();
  assert.strictEqual(livePopups(app).length, 1, 'nothing closes it but React');
  owner.emit('focus', {});
  owner.emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, ['focus', 'focus']);
  await root.unmount();
});

test('a popup that takes the keyboard listens to its own window, not its owner', async () => {
  // On Cocoa a `grabKeyboard` popup is a key window: the owner resigns key
  // as it opens, and that must not close it. On X the keyboard grab sends
  // the owner a FocusOut the same way.
  const app = createMockApp();
  const dismissals = [];
  const root = await mount(
    app,
    h(Menu, { popup: { grab: true, grabKeyboard: true }, dismissals }),
  );
  const [owner] = app.windows;
  const [popup] = livePopups(app);
  owner.emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, [], 'its own opening is not a dismissal');

  popup.emit('focus', {});
  popup.emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, ['focus'], 'its own window losing it is');
  assert.strictEqual(livePopups(app).length, 0);
  await root.unmount();
});

test('a popover with no window above it closes on its own blur', async () => {
  // the tray popover: a root-level `<popup>`, nothing else on screen
  const app = createMockApp();
  const dismissals = [];
  function Popover() {
    const [open, setOpen] = React.useState(true);
    if (!open) return null;
    return h(
      'popup',
      {
        x: 10,
        y: 10,
        width: 100,
        height: 80,
        grab: true,
        grabKeyboard: true,
        onDismiss: (ev) => {
          dismissals.push(ev.reason);
          setOpen(false);
        },
      },
      h('box'),
    );
  }
  const root = await mount(app, h(Popover));
  const [popup] = livePopups(app);
  popup.emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, ['focus']);
  assert.strictEqual(livePopups(app).length, 0);
  await root.unmount();
});

test('a submenu is closed by its root menu, not on its own', async () => {
  // Only a menu's root popup grabs; the submenu under it has no `grab` and
  // no `onDismiss`, and hears nothing — its parent closing takes it along.
  const app = createMockApp();
  const dismissals = [];
  function Nested() {
    const [open, setOpen] = React.useState(true);
    const trigger = React.useRef(null);
    const row = React.useRef(null);
    return h(
      'window',
      { width: 300, height: 200 },
      h('box', { ref: trigger, style: { width: 80, height: 24 } }),
      open &&
        h(
          'popup',
          {
            anchor: { to: trigger, placement: 'bottom' },
            grab: true,
            onDismiss: (ev) => {
              dismissals.push(['root', ev.reason]);
              setOpen(false);
            },
          },
          h('box', { ref: row, style: { width: 120, height: 24 } }),
          h(
            'popup',
            { anchor: { to: row, placement: 'right' } },
            h('box', { style: { width: 100, height: 40 } }),
          ),
        ),
    );
  }
  const root = await mount(app, h(Nested));
  assert.strictEqual(livePopups(app).length, 2, 'the premise: both are up');
  app.windows[0].emit('blur', {});
  await tick();
  assert.deepStrictEqual(dismissals, [['root', 'focus']]);
  assert.strictEqual(livePopups(app).length, 0);
  await root.unmount();
});

// --- the widgets, which used to carry this themselves -----------------------

test('Select and ContextMenu close when their window loses focus', async () => {
  // They used to listen to the window themselves; the popup they open does
  // it now, and this is what keeps them honest about it.
  const { Select, ContextMenu } = await import('../src/index.js');
  const cases = [
    {
      name: 'Select',
      content: h(Select, {
        value: 'a',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
      button: 1,
    },
    {
      name: 'ContextMenu',
      content: h(
        ContextMenu,
        { items: [{ label: 'Copy' }, { label: 'Paste' }] },
        h('box', { style: { width: 200, height: 100 } }),
      ),
      button: 3,
    },
  ];
  for (const { name, content, button } of cases) {
    const app = createMockApp();
    const slot = React.createRef();
    const root = await mount(
      app,
      h(
        'window',
        { width: 300, height: 200 },
        h('box', { ref: slot, style: { alignSelf: 'flex-start' } }, content),
      ),
    );
    const [owner] = app.windows;
    flushFrames(owner);
    // the widget's own box: the Select's trigger, the ContextMenu's area
    const target = slot.current.children[0];
    const x = target.abs.x + target.abs.width / 2;
    const y = target.abs.y + target.abs.height / 2;
    owner.emit('mousedown', { x, y, keycode: button, buttons: 0 });
    owner.emit('mouseup', { x, y, keycode: button, buttons: 0 });
    await tick();
    await tick();
    assert.strictEqual(livePopups(app).length, 1, `${name} opened`);
    owner.emit('blur', {});
    await tick();
    assert.strictEqual(
      livePopups(app).length,
      0,
      `${name} closed when its window lost focus`,
    );
    await root.unmount();
  }
});

// --- Cocoa, where the bug was seen ------------------------------------------

afterEach(cleanupCocoa);

test('Cocoa: switching to another application dismisses the menu', async () => {
  const dismissals = [];
  const trigger = React.createRef();
  function Content() {
    const [open, setOpen] = React.useState(true);
    return h(
      React.Fragment,
      null,
      h('box', { ref: trigger, style: { width: 80, height: 24 } }),
      open &&
        h(
          'popup',
          {
            anchor: {
              to: trigger,
              placement: 'top',
              align: 'start',
              offset: 4,
            },
            grab: true,
            transparent: true,
            onDismiss: (ev) => {
              dismissals.push(ev.reason);
              setOpen(false);
            },
          },
          h('box', { style: { width: 120, height: 60 } }),
        ),
    );
  }
  const { app, wnd } = await mountCocoa(h(Content), {
    width: 300,
    height: 200,
  });
  await tick();
  assert.ok(app._grabWindow, 'the premise: the menu is up and grabbing');

  // A click in another application's window, or ⌘-Tab, sends the app no
  // press at all; what AppKit says is the owner resigning key
  app._route({ type: 'window-blur', windowNumber: wnd.windowNumber });
  await tick();
  assert.deepStrictEqual(dismissals, ['focus']);
  assert.strictEqual(app._grabWindow, null, 'and its grab went with it');
  assert.ok(
    [...app._windows.values()].every((w) => w === wnd || w.destroyed),
    'no popup window is left on screen',
  );
});

test('Cocoa: a key popover is not closed by its owner resigning key to it', async () => {
  const dismissals = [];
  const trigger = React.createRef();
  function Content() {
    const [open, setOpen] = React.useState(true);
    return h(
      React.Fragment,
      null,
      h('box', { ref: trigger, style: { width: 80, height: 24 } }),
      open &&
        h(
          'popup',
          {
            anchor: { to: trigger, placement: 'bottom' },
            grab: true,
            grabKeyboard: true,
            onDismiss: (ev) => {
              dismissals.push(ev.reason);
              setOpen(false);
            },
          },
          h('box', { style: { width: 120, height: 60 } }),
        ),
    );
  }
  const { app, wnd } = await mountCocoa(h(Content));
  await tick();
  const popover = [...app._windows.values()].find((w) => w !== wnd);
  assert.ok(popover?._keyPopup, 'the premise: a key-capable popup');

  // the popover becoming key: the owner resigns first, then it takes it
  app._route({ type: 'window-blur', windowNumber: wnd.windowNumber });
  app._route({ type: 'window-focus', windowNumber: popover.windowNumber });
  await tick();
  assert.deepStrictEqual(dismissals, [], 'opening it is not leaving it');

  // another application taking the key window
  app._route({ type: 'window-blur', windowNumber: popover.windowNumber });
  await tick();
  assert.deepStrictEqual(dismissals, ['focus']);
  assert.ok(popover.destroyed, 'and it is gone');
});
