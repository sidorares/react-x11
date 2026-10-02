// A <Frame> pane's other windows on the Cocoa backend (#824): a dropdown's
// sheet, a menu, a dialog. A pane process runs no AppKit, so an NSWindow
// made there exists and is never shown — a `<Select>` in a pane opened and
// showed nothing. The pane draws such a window into a shared ring as it
// draws itself (`CocoaPaneSubwindow`, src/cocoa/panewindow.js), and the
// host makes the NSWindow, shows the ring in it and sends its input back
// (src/cocoa/panehost.js).
//
// Both ends are real CocoaApps — the host over one fake bridge, the pane in
// pane mode over another — joined by the loopback transport the frame tests
// run panes through, so what crosses is a structured clone, as over the
// fork. What reaches each bridge is the whole of what the glue decides.
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import React from 'react';

import { CocoaApp } from '../src/cocoa/app.js';
import { setCompositingForTests } from '../src/compositing.js';
import { Frame } from '../src/frame/index.js';
import { Select, createRoot } from '../src/index.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { loopbackFrameFactory } from './helpers/frame-loopback.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;
const PANE = new URL('./fixtures/popup-pane.js', import.meta.url);

/** Enough of @windowkit/appkit for windows, shared surfaces and layers,
 * recording what decides something. Points in, as AppKit's are. */
function fakeBridge() {
  const calls = [];
  const windows = new Map();
  let seq = 0;
  const base = {
    calls,
    windows,
    of: (name) => calls.filter((c) => c[0] === name).map((c) => c.slice(1)),
    setBackendEventCallback() {},
    initApp() {},
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 2,
        fps: 60,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2(options) {
      const handle = { id: ++seq, options: { ...options }, shown: false };
      windows.set(handle.id, handle);
      calls.push(['createWindow2', handle.id, { ...options }]);
      return handle;
    },
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: handle.options.x ?? 0,
      y: handle.options.y ?? 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    setWindowFrame(handle, x, y, width, height) {
      if (typeof x === 'number') handle.options.x = x;
      if (typeof y === 'number') handle.options.y = y;
      if (typeof width === 'number') handle.options.width = width;
      if (typeof height === 'number') handle.options.height = height;
      calls.push(['setWindowFrame', handle.id, x, y, width, height]);
    },
    showWindow(handle, key) {
      handle.shown = true;
      calls.push(['showWindow', handle.id, key]);
    },
    hideWindow(handle) {
      handle.shown = false;
      calls.push(['hideWindow', handle.id]);
    },
    destroyWindow2(handle) {
      handle.shown = false;
      handle.destroyed = true;
      calls.push(['destroyWindow2', handle.id]);
    },
    windowIsVisible: () => true,
    createSurfaceIOSurface: (width, height, scale) => {
      const id = ++seq;
      return { handle: { id, width, height, scale }, iosurfaceId: id };
    },
    createSurface: (width, height, scale) => ({
      id: ++seq,
      width,
      height,
      scale,
    }),
    surfaceSize: (s) => ({ width: s.width, height: s.height, scale: s.scale }),
    createLayer: () => ({ layer: ++seq }),
    addSublayer(parent, layer) {
      calls.push(['addSublayer', parent, layer]);
    },
    setLayerContentsIOSurface(layer, id) {
      calls.push(['flip', layer, id]);
    },
    // A pop-up menu (bridge 0.20): what was asked for, and its callback, for
    // the test to answer as a person would; a cancel answers null.
    menus: [],
    popUpMenu(handle, spec, cb) {
      const menu = { menu: ++seq, handle, spec, cb, cancelled: false };
      base.menus.push(menu);
      return menu;
    },
    cancelPopUpMenu(menu) {
      menu.cancelled = true;
      queueMicrotask(() => menu.cb(null));
    },
  };
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function appOver(native, options) {
  const app = new CocoaApp(native, options);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  app._frameInterval = 0;
  // no CoreText behind the fake: text lays out as it does on the mock,
  // which has no font manager either (nodes/text.js `_layoutFor`)
  app.fonts = null;
  native.setBackendEventCallback((ev) => app._route(ev));
  return app;
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/** Let the channel's microtasks and both apps' frames run, a few times
 * over: a press in the host is a message, a commit and a frame in the pane,
 * and the window the frame made is a message and a frame back. */
async function settle(...apps) {
  for (let i = 0; i < 16; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    for (const app of apps) {
      app._tickFrames();
      app._presentAll();
    }
  }
}

/** Settle until `predicate` holds. The pane's first mount imports its
 * module from disk, which is I/O no count of turns is sure to outlast on a
 * slow runner; everything after it is the channel's microtasks. */
async function until(apps, predicate, what, { tries = 400, delay = 2 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    await settle(...apps);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  assert.fail(`timed out waiting for ${what}`);
}

function find(node, test) {
  if (test(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, test);
    if (hit) return hit;
  }
  return null;
}

function findAll(node, test, out = []) {
  if (test(node)) out.push(node);
  for (const child of node.children ?? []) findAll(child, test, out);
  return out;
}

/** A click in one of the host's windows, at a point in it — what the
 * bridge reports, in points. */
function click(app, wnd, x, y) {
  const s = app.scale;
  const ev = {
    windowNumber: wnd.windowNumber,
    x,
    y,
    gx: x + wnd.x / s,
    gy: y + wnd.y / s,
    button: 1,
    time: Date.now(),
  };
  app._route({ type: 'mousedown', ...ev });
  app._route({ type: 'mouseup', ...ev });
}

/**
 * A host window at (100, 50) on the screen, a <Frame> 40 points in and 30
 * down, and in it the fixture: a `<Select>` 20 points into the pane.
 */
async function mount(paneProps = {}) {
  const hostNative = fakeBridge();
  const host = appOver(hostNative);
  const paneNative = fakeBridge();
  const pane = appOver(paneNative, { pane: true });
  const factory = loopbackFrameFactory({ childApp: pane });
  const picks = [];
  const closes = [];
  let props = {
    onPick: (value) => picks.push(value),
    onCloseDialog: () => closes.push(true),
    ...paneProps,
  };
  const tree = (withFrame = true) =>
    h(
      'window',
      { width: 400, height: 300, x: 100, y: 50 },
      h(
        'box',
        { style: { paddingLeft: 40, paddingTop: 30 } },
        withFrame
          ? h(Frame, {
              src: PANE,
              transport: factory,
              props,
              style: { width: 300, height: 200 },
            })
          : null,
      ),
    );
  const root = await createRoot({ app: host });
  roots.push(root);
  root.render(tree());
  const hostWnd = [...host._windows.values()][0];
  const frameBoxNow = () =>
    find(
      hostWnd._reactX11Node,
      (n) => n.props?.focusable === true && n.abs?.width === 600,
    );
  // mounted, laid out in the host, and told so: the first pane-rect is
  // what lets the pane's windows out (`CocoaApp._postWindow`)
  await until(
    [host, pane],
    () =>
      Boolean(
        pane._paneWindow?._reactX11Node &&
        pane._paneOutbox === null &&
        frameBoxNow(),
      ),
    'the pane to mount and be laid out in the host',
  );
  await settle(host, pane);
  const frameBox = frameBoxNow();
  const paneWnd = pane._paneWindow;
  const trigger = () =>
    find(paneWnd._reactX11Node, (n) => n.props?.role === 'combobox');
  /** The host's window for one of the pane's, by what the pane made. */
  const hosted = (kind) => {
    const made = hostNative
      .of('createWindow2')
      .filter(([, o]) => o.kind === kind);
    const last = made.at(-1);
    return last ? hostNative.windows.get(last[0]) : null;
  };
  /** Settle until the host shows a window of `kind` that is still up. */
  const shows = (kind, what) =>
    until(
      [host, pane],
      () => {
        const w = hosted(kind);
        return Boolean(w && w.shown && !w.destroyed && w.id !== hostWnd._key);
      },
      what,
    );
  const open = async () => {
    const t = trigger().abs;
    const s = host.scale;
    click(
      host,
      hostWnd,
      (frameBox.abs.x + t.x + 20) / s,
      (frameBox.abs.y + t.y + t.height / 2) / s,
    );
    await shows('popup', 'the menu to show');
  };
  return {
    host,
    hostNative,
    hostWnd,
    pane,
    paneNative,
    paneWnd,
    frameBox,
    trigger,
    hosted,
    shows,
    open,
    picks,
    closes,
    root,
    unmountFrame: () => root.render(tree(false)),
    /** New props for the pane, as a parent re-rendering hands them. */
    update: async (more) => {
      props = { ...props, ...more };
      root.render(tree());
      await settle(host, pane);
    },
  };
}

test('a menu a pane opens is a window the host makes, under the trigger on the screen', async () => {
  const m = await mount();
  const s = m.host.scale;
  // where the pane is on the screen, which it has no window to ask
  assert.deepStrictEqual(m.paneWnd._screenOrigin, {
    x: m.hostWnd.x + m.frameBox.abs.x,
    y: m.hostWnd.y + m.frameBox.abs.y,
  });
  assert.strictEqual(m.hosted('popup'), null, 'no menu yet');

  await m.open();
  const sub = [...m.pane._windows.values()].find((w) => w._popup);
  assert.ok(sub, 'the pane made the menu');
  assert.strictEqual(
    m.paneNative.of('createWindow2').length,
    0,
    'and no NSWindow of its own for it',
  );
  const popup = m.hosted('popup');
  assert.ok(popup, 'the host made an NSWindow for it');
  // under the trigger, in screen points — the host window's origin, the
  // frame's box in it and the trigger's in the pane, and `anchorRect`'s
  // two-point gap — where it dropped from the pane-local point before
  const t = m.trigger().abs;
  assert.deepStrictEqual(
    [popup.options.x, popup.options.y],
    [
      (m.hostWnd.x + m.frameBox.abs.x + t.x) / s,
      (m.hostWnd.y + m.frameBox.abs.y + t.y + t.height) / s + 2,
    ],
  );
  assert.deepStrictEqual(
    [popup.options.width, popup.options.height],
    [sub.width / s, sub.height / s],
    'at the size the pane laid it out',
  );
  assert.ok(popup.shown, 'and showed it');
  assert.ok(
    m.hostNative.of('showWindow').some(([id, key]) => id === popup.id && !key),
    'without taking the keyboard from the window the trigger is in',
  );
  // …showing what the pane drew into it
  const [, layer] = m.hostNative
    .of('addSublayer')
    .find(([parent]) => parent.root === popup.id);
  const flips = m.hostNative.of('flip').filter(([l]) => l === layer);
  assert.ok(flips.length > 0, 'the pane presented the menu');
  assert.strictEqual(
    flips.at(-1)[1],
    sub._ring[sub._shownIndex].iosurfaceId,
    "the layer shows the pane's last frame of it",
  );
});

test("a click in the host's window for the menu picks in the pane, and the menu goes", async () => {
  const m = await mount();
  await m.open();
  const popup = m.hosted('popup');
  const sub = [...m.pane._windows.values()].find((w) => w._popup);
  const options = findAll(sub._reactX11Node, (n) => n.props?.role === 'option');
  assert.strictEqual(options.length, 3);
  const beta = options[1].abs;
  const s = m.host.scale;
  click(
    m.host,
    m.host._windows.get(popup.id),
    (beta.x + beta.width / 2) / s,
    (beta.y + beta.height / 2) / s,
  );
  await settle(m.host, m.pane);
  assert.deepStrictEqual(m.picks, ['beta']);
  assert.ok(popup.destroyed, "the host's window went with the menu");
  assert.ok(sub.destroyed);
  assert.ok(m.host._grabWindow == null, 'and took its grab with it');
});

test('a press anywhere else in the host dismisses the menu, through the grab', async () => {
  const m = await mount();
  await m.open();
  const popup = m.hosted('popup');
  // compared by hand: a failing strictEqual formats both windows, which
  // are cyclic and enormous
  assert.ok(
    m.host._grabWindow === m.host._windows.get(popup.id),
    "the menu's grab is the host's",
  );
  click(m.host, m.hostWnd, 380, 280);
  await settle(m.host, m.pane);
  assert.ok(popup.destroyed, 'dismissed');
  assert.deepStrictEqual(m.picks, [], 'and nothing was picked');
});

test('a menu follows the host window, and one opened after a move opens where the window went', async () => {
  const m = await mount();
  await m.open();
  const popup = m.hosted('popup');
  const before = [popup.options.x, popup.options.y];
  // AppKit's windowDidMove, in points: 200 right and 150 down
  m.host._route({
    type: 'window-move',
    windowNumber: m.hostWnd.windowNumber,
    x: 300,
    y: 200,
    width: 400,
    height: 300,
  });
  await settle(m.host, m.pane);
  assert.deepStrictEqual(m.paneWnd._screenOrigin, {
    x: 600 + m.frameBox.abs.x,
    y: 400 + m.frameBox.abs.y,
  });
  assert.deepStrictEqual(
    [popup.options.x, popup.options.y],
    [before[0] + 200, before[1] + 150],
    'the open menu moved with it',
  );

  click(m.host, m.hostWnd, 380, 280);
  await settle(m.host, m.pane);
  await m.open();
  const again = m.hosted('popup');
  assert.notStrictEqual(again, popup);
  assert.deepStrictEqual(
    [again.options.x, again.options.y],
    [before[0] + 200, before[1] + 150],
  );
});

test('the host window losing focus closes a menu the pane holds open on it', async () => {
  const m = await mount();
  await m.open();
  const popup = m.hosted('popup');
  m.host._route({ type: 'window-blur', windowNumber: m.hostWnd.windowNumber });
  await settle(m.host, m.pane);
  assert.ok(popup.destroyed);
});

test('a popup the pane opens before the host has laid it out waits for it, and is placed again before it is shown', async () => {
  // Open in the pane's first commit: made, and anchored against the corner
  // of a screen the pane had not been told its place on. Sent then, the
  // host was not listening yet — the window was announced to nobody.
  const m = await mount({ pinned: true });
  await m.shows('popup', 'the pinned popup to show');
  const popup = m.hosted('popup');
  assert.ok(popup, 'the host made it');
  const mark = find(
    m.paneWnd._reactX11Node,
    (n) => n.abs?.width === 120 && n.abs?.height === 20,
  ).abs;
  const s = m.host.scale;
  assert.deepStrictEqual(
    [popup.options.x, popup.options.y],
    [
      (m.hostWnd.x + m.frameBox.abs.x + mark.x) / s,
      (m.hostWnd.y + m.frameBox.abs.y + mark.y + mark.height) / s,
    ],
    'under its anchor, where the pane is on the screen',
  );
  assert.ok(popup.shown);
  // …and only shown once it was there
  const calls = m.hostNative.calls;
  const shownAt = calls.findIndex(
    ([name, id]) => name === 'showWindow' && id === popup.id,
  );
  const movedAt = calls.findLastIndex(
    ([name, id]) => name === 'setWindowFrame' && id === popup.id,
  );
  assert.ok(movedAt < shownAt, 'placed before it was shown');
});

test('a pane that goes takes its windows with it', async () => {
  const m = await mount();
  await m.open();
  const popup = m.hosted('popup');
  m.unmountFrame();
  await settle(m.host, m.pane);
  assert.ok(popup.destroyed, 'no menu left behind');
  assert.ok(m.host._grabWindow == null, 'and no grab');
});

test("a dialog a pane opens is a managed window the host makes, centred over the pane, and its close button is the pane's", async () => {
  const m = await mount();
  await m.update({ dialog: true });
  await m.shows('normal', 'the dialog to show');
  const dialog = m.hosted('normal');
  assert.notStrictEqual(dialog.id, m.hostWnd.windowNumber, 'a second window');
  assert.strictEqual(dialog.options.title, 'Settings');
  assert.ok(dialog.shown);
  assert.ok(
    m.hostNative.of('showWindow').some(([id, key]) => id === dialog.id && key),
    'and it takes the keyboard, as a dialog does',
  );
  // centred over the pane's window, which is where on the screen the host
  // said the pane is
  const s = m.host.scale;
  const pane = {
    x: (m.hostWnd.x + m.frameBox.abs.x) / s,
    y: (m.hostWnd.y + m.frameBox.abs.y) / s,
  };
  assert.deepStrictEqual(
    [dialog.options.x, dialog.options.y],
    [pane.x + (300 - 360) / 2, pane.y + (200 - 170) / 2],
  );
  const sub = [...m.pane._windows.values()].find(
    (w) => w.attributes?.overrideRedirect === false,
  );
  // the user moves it: the pane hears where it went, which is what the
  // dialog's own popups are placed against
  m.host._route({
    type: 'window-move',
    windowNumber: dialog.id,
    x: 500,
    y: 400,
    width: dialog.options.width,
    height: dialog.options.height,
  });
  await settle(m.host, m.pane);
  assert.deepStrictEqual(sub._screenOrigin, { x: 1000, y: 800 });
  m.host._route({ type: 'window-close-request', windowNumber: dialog.id });
  await settle(m.host, m.pane);
  assert.deepStrictEqual(m.closes, [true]);
});

// --- the platform's menu (bridge 0.20) ---------------------------------------

test("a select's platform menu is the bridge's, dropped from the trigger in points after the press is answered", async () => {
  const native = fakeBridge();
  const app = appOver(native);
  const root = await createRoot({ app });
  roots.push(root);
  const changes = [];
  root.render(
    h(
      'window',
      { width: 300, height: 200, x: 100, y: 50 },
      h(
        'box',
        { style: { padding: 30, alignItems: 'flex-start' } },
        h(Select, {
          options: ['alpha', 'beta', 'gamma'],
          value: 'beta',
          native: false,
          nativeMenu: true,
          style: { width: 120 },
          onChange: (ev) => changes.push(ev.value),
        }),
      ),
    ),
  );
  await settle(app);
  const wnd = [...app._windows.values()][0];
  const trigger = find(wnd._reactX11Node, (n) => n.props?.role === 'combobox');
  const t = trigger.abs;
  const s = app.scale;
  click(app, wnd, (t.x + 20) / s, (t.y + t.height / 2) / s);
  assert.equal(
    native.menus.length,
    0,
    'not inside the press: a microtask after it',
  );
  await settle(app);
  assert.equal(native.menus.length, 1, "the bridge's menu");
  const [menu] = native.menus;
  assert.ok(menu.handle === wnd._h, "from the trigger's window");
  assert.deepStrictEqual(
    menu.spec.frame,
    [t.x / s, t.y / s, t.width / s, t.height / s],
    'its frame in points',
  );
  assert.strictEqual(menu.spec.selected, 2);
  assert.strictEqual(
    native.of('createWindow2').length,
    1,
    'and no window of ours for it',
  );
  menu.cb(3);
  await settle(app);
  assert.deepStrictEqual(changes, ['gamma']);
  assert.strictEqual(trigger.props['aria-expanded'], false);
});

test("a pane's platform menu is dropped by the host, over the pane's place in its window, and the pick goes back", async () => {
  const m = await mount({ nativeMenu: true });
  const t = m.trigger().abs;
  const s = m.host.scale;
  click(
    m.host,
    m.hostWnd,
    (m.frameBox.abs.x + t.x + 20) / s,
    (m.frameBox.abs.y + t.y + t.height / 2) / s,
  );
  await until(
    [m.host, m.pane],
    () => m.hostNative.menus.length === 1,
    "the host's menu",
  );
  assert.strictEqual(m.paneNative.menus.length, 0, 'none in the pane');
  const [menu] = m.hostNative.menus;
  assert.ok(menu.handle === m.hostWnd._h, "in the host's window");
  assert.deepStrictEqual(
    menu.spec.frame,
    [
      (m.frameBox.abs.x + t.x) / s,
      (m.frameBox.abs.y + t.y) / s,
      t.width / s,
      t.height / s,
    ],
    "the trigger's box, where the pane is laid out in the host",
  );
  assert.strictEqual(m.hosted('popup'), null, 'and no drawn menu');
  menu.cb(2);
  await until([m.host, m.pane], () => m.picks.length > 0, 'the pick');
  assert.deepStrictEqual(m.picks, ['beta']);

  // opened again, and the pane goes: its menu goes with it
  click(
    m.host,
    m.hostWnd,
    (m.frameBox.abs.x + t.x + 20) / s,
    (m.frameBox.abs.y + t.y + t.height / 2) / s,
  );
  await until(
    [m.host, m.pane],
    () => m.hostNative.menus.length === 2,
    'the menu again',
  );
  m.unmountFrame();
  await settle(m.host, m.pane);
  assert.ok(m.hostNative.menus[1].cancelled, 'cancelled with the pane');
});
