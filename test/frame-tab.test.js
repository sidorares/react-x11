// Tab through a `<Frame>`: one order, the host's and the pane's together.
//
// A composited pane (Cocoa, Windows) is a box in the host's tree and a
// window in a process of its own, and each has an order of its own. The
// chain between them is XEmbed's for a `<foreign>`: Tab arriving at the box
// goes on into the pane at its first stop (a back-Tab, its last); Tab while
// the box has the focus is the pane's; and the pane running off an end of
// its order hands Tab back, and the host goes on from the box.
//
// Before it, the box took one Tab and the pane the next — the host sent the
// key on and cycled its own focus as well — so Tab went from one of the
// pane's stops to one of the host's and back, never to the pane's next.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';

import { Frame, createRoot } from '../src/index.js';
import { MOD, XK_TAB } from '../src/keysyms.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

const PANE = new URL('./fixtures/pane-that-is-never-run.js', import.meta.url);

/** Simulate an ntk keydown: bind the keysym to a synthetic keycode and emit
 *  the raw event shape the EventManager consumes. */
function pressKey(app, wnd, keysym, { shift = false, ctrl = false } = {}) {
  const keycode = (keysym % 248) + 8;
  app.X.keycode2keysyms[keycode] = [keysym];
  const buttons = (shift ? MOD.Shift : 0) | (ctrl ? MOD.Control : 0);
  wnd.emit('keydown', { keycode, keysym, buttons });
}

/** A host window: a stop, a `<Frame>` over a pane that comes up at once,
 *  and a stop — or only the frame. `onKeyDown` is the window's. */
async function mountHost({ alone = false, onKeyDown } = {}) {
  const app = createMockApp();
  app.createPaneHost = () => ({ setRect() {}, present() {}, destroy() {} });
  const sent = [];
  let deliver = null;
  const transport = () => ({
    send: (msg) => sent.push(msg),
    onMessage: (cb) => {
      deliver = cb;
      setImmediate(() => cb({ type: 'ready', windowId: 1 }));
      return () => {};
    },
    onExit: () => () => {},
    pid: -1,
  });
  const nodes = {};
  const stop = (name) =>
    h('box', {
      ref: (n) => (nodes[name] = n),
      focusable: true,
      style: { height: 20, flexShrink: 0 },
    });
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 200, height: 160, onKeyDown },
      alone ? null : stop('before'),
      h(Frame, {
        src: PANE,
        transport,
        style: { flexGrow: 1 },
      }),
      alone ? null : stop('after'),
    ),
  );
  await settle();
  const wnd = app.windows[0];
  wnd.flushFrame?.();
  const manager = wnd._reactX11Node.events;
  // the box the pane is shown in: the window's one focusable that is no stop
  const pane = manager
    ._focusables()
    .find((n) => n !== nodes.before && n !== nodes.after);
  const focused = () => {
    const at = manager.focusManager.focused;
    if (at === pane) return 'pane';
    return Object.keys(nodes).find((k) => nodes[k] === at) ?? at;
  };
  const toPane = (name) =>
    sent
      .filter(
        (m) =>
          m.type === 'pane-event' &&
          (name ? m.name === name : !/^mouse/.test(m.name)),
      )
      .map((m) =>
        m.name === 'tabenter'
          ? `tabenter:${m.ev.backwards ? 'last' : 'first'}`
          : `${m.name}:${m.ev.keysym}:${m.ev.buttons}`,
      );
  return {
    app,
    wnd,
    root,
    manager,
    pane,
    focused,
    sent,
    toPane,
    fromPane: (msg) => deliver(msg),
    tab: (opts) => pressKey(app, wnd, XK_TAB, opts),
  };
}

describe('<Frame>: Tab between the host and a composited pane', () => {
  it('Tab arriving at the pane goes on into it, at its first stop, or its last for a back-Tab', async () => {
    const host = await mountHost();
    host.tab();
    assert.equal(host.focused(), 'before');
    host.sent.length = 0;
    host.tab();
    assert.equal(host.focused(), 'pane');
    assert.deepEqual(host.toPane('tabenter'), ['tabenter:first']);

    host.manager.focus(host.manager._focusables().at(-1), 'key');
    host.sent.length = 0;
    host.tab({ shift: true });
    assert.equal(host.focused(), 'pane');
    assert.deepEqual(host.toPane('tabenter'), ['tabenter:last']);
    await host.root.unmount();
  });

  it('Tab while the pane has the focus is the pane’s: sent on, with its Shift, and not cycled here', async () => {
    const host = await mountHost();
    host.manager.focus(host.pane, 'pointer');
    host.sent.length = 0;
    host.tab();
    host.tab({ shift: true });
    assert.equal(host.focused(), 'pane', 'the host moved its focus as well');
    // the modifier mask is on the native event alone, and was sent as none
    assert.deepEqual(host.toPane('keydown'), [
      `keydown:${XK_TAB}:0`,
      `keydown:${XK_TAB}:${MOD.Shift}`,
    ]);
    // a press is not a Tab: it lands where the pane has its focus already
    assert.deepEqual(host.toPane('tabenter'), []);
    await host.root.unmount();
  });

  it('a pane that runs off an end of its order hands Tab back, and the host goes on from the pane', async () => {
    const host = await mountHost();
    host.manager.focus(host.pane, 'key');
    host.fromPane({ type: 'pane-tab-out', backwards: false });
    assert.equal(host.focused(), 'after');

    host.manager.focus(host.pane, 'key');
    host.fromPane({ type: 'pane-tab-out', backwards: true });
    assert.equal(host.focused(), 'before');

    // and only from a focus the pane holds: the host's has moved on since
    host.fromPane({ type: 'pane-tab-out', backwards: false });
    assert.equal(host.focused(), 'before', 'a late hand-back moved the focus');
    await host.root.unmount();
  });

  it('a pane that is the window’s only stop is entered again, at the end Tab comes to next', async () => {
    const host = await mountHost({ alone: true });
    host.manager.focus(host.pane, 'pointer');
    host.sent.length = 0;
    host.fromPane({ type: 'pane-tab-out', backwards: false });
    host.fromPane({ type: 'pane-tab-out', backwards: true });
    assert.equal(host.focused(), 'pane');
    assert.deepEqual(host.toPane('tabenter'), [
      'tabenter:first',
      'tabenter:last',
    ]);
    await host.root.unmount();
  });

  it('a chord the application answered above the pane does not reach it', async () => {
    // Ctrl+Tab is a browser's next tab. Sent on from the box's handler, it
    // switched the tab and moved the focus in the page as well.
    const host = await mountHost({
      onKeyDown: (ev) => {
        if (ev.keysym === XK_TAB && ev.ctrlKey) ev.preventDefault();
      },
    });
    host.manager.focus(host.pane, 'pointer');
    host.sent.length = 0;
    host.tab({ ctrl: true });
    assert.deepEqual(host.toPane('keydown'), []);
    assert.equal(host.focused(), 'pane');
    await host.root.unmount();
  });
});

describe('the pane’s half: a window that is a stop in another’s order', () => {
  /** A window whose backend says it hands Tab on (`tabOut`), as a pane's
   *  does, with three stops in it — and a modal over them, on request. */
  async function mountPane({ modal = false } = {}) {
    const app = createMockApp();
    const refs = {};
    const stop = (name) =>
      h('box', {
        ref: (n) => (refs[name] = n),
        focusable: true,
        style: { height: 10, flexShrink: 0 },
      });
    const root = await createRoot({ app });
    root.render(
      h(
        'window',
        { width: 200, height: 120 },
        stop('a'),
        stop('b'),
        stop('c'),
        modal
          ? h(
              'popup',
              { trapFocus: true, x: 10, y: 10, width: 120, height: 60 },
              stop('m1'),
              stop('m2'),
            )
          : null,
      ),
    );
    await settle();
    const wnd = app.windows[0];
    const handed = [];
    wnd.tabOut = (backwards) => {
      handed.push(backwards ? 'back' : 'on');
      return true;
    };
    const manager = wnd._reactX11Node.events;
    const focused = () => {
      const at = manager.focusManager.focused;
      return at ? Object.keys(refs).find((k) => refs[k] === at) : null;
    };
    return {
      app,
      wnd,
      root,
      refs,
      handed,
      manager,
      focused,
      tab: (opts) => pressKey(app, wnd, XK_TAB, opts),
    };
  }

  it('Tab off either end is handed on, and the window lets go of its focus', async () => {
    const pane = await mountPane();
    pane.wnd.emit('tabenter', { backwards: false });
    assert.equal(pane.focused(), 'a');
    assert.equal(pane.refs.a.states[':focus-visible'], true);
    pane.tab();
    pane.tab();
    assert.equal(pane.focused(), 'c');
    pane.tab();
    assert.deepEqual(pane.handed, ['on']);
    assert.equal(pane.focused(), null, 'the last stop kept its ring');

    pane.wnd.emit('tabenter', { backwards: true });
    assert.equal(pane.focused(), 'c');
    pane.tab({ shift: true });
    pane.tab({ shift: true });
    pane.tab({ shift: true });
    assert.deepEqual(pane.handed, ['on', 'back']);
    assert.equal(pane.focused(), null);
    await pane.root.unmount();
  });

  it('with nothing focused, Tab enters at an end rather than handing on', async () => {
    const pane = await mountPane();
    pane.tab();
    assert.equal(pane.focused(), 'a');
    pane.manager.focus(null);
    pane.tab({ shift: true });
    assert.equal(pane.focused(), 'c');
    assert.deepEqual(pane.handed, []);
    await pane.root.unmount();
  });

  it('a modal in the window keeps Tab going round inside it', async () => {
    const pane = await mountPane({ modal: true });
    pane.manager.focus(pane.refs.m2, 'key');
    pane.tab();
    assert.equal(pane.focused(), 'm1');
    assert.deepEqual(pane.handed, []);
    await pane.root.unmount();
  });

  it('a window whose backend takes nothing goes round, as every window does', async () => {
    const pane = await mountPane();
    pane.wnd.tabOut = () => false;
    pane.manager.focus(pane.refs.c, 'key');
    pane.tab();
    assert.equal(pane.focused(), 'a');
    await pane.root.unmount();
  });
});
