// `<Frame>` asks whether a pane can be *shown* before it starts one.
//
// A pane reaches the screen one of two ways: a backend composites it from a
// shared buffer (`createPaneHost` — Cocoa, Windows), or it embeds the pane's
// own window (`canEmbed` — X11). A backend with neither has nowhere to put a
// pane, and that is knowable from the app object.
//
// It used to be discovered at the embed, which is *after* the fork: a whole
// process started, a module loaded, a tree mounted and the lot killed again,
// to reach a conclusion available before any of it. The fallback is the same
// either way; what this holds is that nothing is spawned to get there.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';

import { Frame, createRoot } from '../src/index.js';
import { PANE_SIZED_WAIT_MS } from '../src/frame/index.js';
import {
  createMockApp,
  flushFrames,
  moveMouse,
  spinWheel,
} from './helpers/mock-app.js';

const h = React.createElement;
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

const PANE = new URL('./fixtures/pane-that-is-never-run.js', import.meta.url);

/** Mount one `<Frame>` and report whether anything asked for a process. */
async function mount(app) {
  let forks = 0;
  let error = null;
  const transport = () => {
    forks += 1;
    return {
      send() {},
      onMessage: () => () => {},
      onExit: () => () => {},
      pid: -1,
    };
  };
  const root = await createRoot({ app });
  root.render(
    h(
      'window',
      { width: 200, height: 120 },
      h(Frame, {
        src: PANE,
        transport,
        fallback: ({ error: err }) => {
          error = err;
          return h('text', null, 'fallback');
        },
      }),
    ),
  );
  await settle();
  return { forks, error, root };
}

describe('<Frame>: asking before forking', () => {
  it('starts no process on a backend that can show no pane', async () => {
    const { forks, error, root } = await mount(createMockApp());
    assert.equal(forks, 0, 'it forked for a pane it could not have shown');
    assert.ok(error, 'no fallback was rendered');
    assert.match(error.message, /needs a backend that can show a pane/);
    // The same phase the embed failure reported, because it is the same
    // fact — found earlier, not found differently.
    assert.equal(error.phase, 'embed');
    await root.unmount();
  });

  it('starts one on a backend that composites panes', async () => {
    const app = createMockApp();
    app.createPaneHost = () => ({
      setRect() {},
      present() {},
      destroy() {},
    });
    const { forks, error, root } = await mount(app);
    assert.equal(forks, 1);
    assert.equal(error, null, `it refused anyway: ${error?.message}`);
    await root.unmount();
  });

  it('starts one on a backend that embeds windows', async () => {
    const app = createMockApp();
    // What `canEmbed` actually asks for (src/embedding.js) — the two
    // requests an XEmbed socket is built out of.
    app.X.ReparentWindow = () => {};
    app.X.ChangeSaveSet = () => {};
    const { forks, error, root } = await mount(app);
    assert.equal(forks, 1);
    assert.equal(error, null, `it refused anyway: ${error?.message}`);
    await root.unmount();
  });
});

describe('<Frame>: input forwarded to a composited pane', () => {
  // A composited pane has no window the pointer is over: the host hears its
  // input and sends it on, and the pane's window emits it as its own. The
  // wheel reaches the host as a synthetic event, in pixels — events.js has
  // already turned each notch into WHEEL_NOTCH_PX of them — and the pane's
  // window turns what it is sent into pixels again. Sent the pixels, a
  // notch scrolled a page 48 notches' worth, 2304 pixels.
  it('a wheel notch reaches the pane as a notch, and a touchpad fraction as that fraction', async () => {
    const app = createMockApp();
    app.createPaneHost = () => ({ setRect() {}, present() {}, destroy() {} });
    const sent = [];
    // a pane that comes up at once: the host forwards input to a running one
    const transport = () => ({
      send: (msg) => sent.push(msg),
      onMessage: (cb) => {
        setImmediate(() => cb({ type: 'ready', windowId: 1 }));
        return () => {};
      },
      onExit: () => () => {},
      pid: -1,
    });
    const root = await createRoot({ app });
    root.render(
      h(
        'window',
        { width: 200, height: 120 },
        h(Frame, { src: PANE, transport, style: { flexGrow: 1 } }),
      ),
    );
    await settle();
    flushFrames(app.windows[0]);
    spinWheel(app.windows[0], 50, 50, { deltaY: 1 });
    spinWheel(app.windows[0], 50, 50, { deltaY: -0.25, smooth: true });
    await settle();
    const wheels = sent
      .filter((m) => m.type === 'pane-event' && m.name === 'wheel')
      .map((m) => [m.ev.deltaX, m.ev.deltaY, m.ev.smooth]);
    assert.deepEqual(wheels, [
      [0, 1, false],
      [0, -0.25, true],
    ]);
    await root.unmount();
  });

  // The pane cannot hear the pointer leave: it has no window for a leave to
  // arrive at. Told of motion and never of its end, it kept hovered whatever
  // the pointer last crossed in it — a link in a page, with the pointer on
  // the host's toolbar. The same message is what ends its hover when the
  // host is no longer the active window, on a backend that keeps hover to
  // that one (`EventManager.hoverLive`).
  it('the pointer leaving the pane, or the host losing the keyboard, reaches it as a leave', async () => {
    const app = createMockApp();
    app.hoverNeedsActiveWindow = true;
    app.createPaneHost = () => ({ setRect() {}, present() {}, destroy() {} });
    const sent = [];
    const transport = () => ({
      send: (msg) => sent.push(msg),
      onMessage: (cb) => {
        setImmediate(() => cb({ type: 'ready', windowId: 1 }));
        return () => {};
      },
      onExit: () => () => {},
      pid: -1,
    });
    const root = await createRoot({ app });
    root.render(
      h(
        'window',
        { width: 200, height: 120 },
        h('box', { style: { height: 40, flexShrink: 0 } }),
        h(Frame, { src: PANE, transport, style: { flexGrow: 1 } }),
      ),
    );
    await settle();
    const wnd = app.windows[0];
    flushFrames(wnd);
    const pointer = () =>
      sent
        .filter((m) => m.type === 'pane-event' && /^mouse/.test(m.name))
        .map((m) => m.name);

    moveMouse(wnd, 50, 80);
    moveMouse(wnd, 50, 20); // onto the box above the pane
    assert.deepEqual(pointer(), ['mousemove', 'mouseout']);

    sent.length = 0;
    moveMouse(wnd, 50, 80);
    wnd.emit('blur', {});
    moveMouse(wnd, 60, 80);
    assert.deepEqual(
      pointer(),
      ['mousemove', 'mouseout'],
      'and no motion after it, until the window is the active one again',
    );
    await root.unmount();
  });
});

describe('<Frame>: the cursor of a composited pane', () => {
  // The pointer is over the host's window, so the host shows the cursor the
  // pane's tree names (`pane-cursor`). It arrives after the motion that
  // changed it was answered here, which is why it is applied on arrival.
  async function mountPane(frameStyle = {}) {
    const app = createMockApp();
    app.createPaneHost = () => ({ setRect() {}, present() {}, destroy() {} });
    const listeners = [];
    const transport = () => ({
      send() {},
      onMessage: (cb) => {
        listeners.push(cb);
        setImmediate(() => cb({ type: 'ready', windowId: 1 }));
        return () => listeners.splice(listeners.indexOf(cb) >>> 0, 1);
      },
      onExit: () => () => {},
      pid: -1,
    });
    const root = await createRoot({ app });
    root.render(
      h(
        'window',
        { width: 200, height: 120 },
        h(Frame, {
          src: PANE,
          transport,
          style: { flexGrow: 1, ...frameStyle },
        }),
      ),
    );
    await settle();
    const wnd = app.windows[0];
    flushFrames(wnd);
    const fromPane = (msg) => {
      for (const cb of [...listeners]) cb(msg);
    };
    return { root, wnd, fromPane };
  }

  it('shows the cursor the pane names, when it names it', async () => {
    const { root, wnd, fromPane } = await mountPane();
    moveMouse(wnd, 50, 50);
    assert.equal(wnd.cursor ?? null, null);
    fromPane({ type: 'pane-cursor', cursor: 'pointer' });
    assert.equal(wnd.cursor, 'pointer', 'with no motion after it');
    moveMouse(wnd, 60, 50);
    assert.equal(wnd.cursor, 'pointer', 'and as the pointer goes on over it');
    fromPane({ type: 'pane-cursor', cursor: null });
    assert.equal(wnd.cursor, null, 'none is the default');
    await root.unmount();
  });

  it('a cursor style on the <Frame> wins over the pane', async () => {
    const { root, wnd, fromPane } = await mountPane({ cursor: 'crosshair' });
    moveMouse(wnd, 50, 50);
    fromPane({ type: 'pane-cursor', cursor: 'pointer' });
    assert.equal(wnd.cursor, 'crosshair');
    await root.unmount();
  });
});

describe('<Frame>: the size of a composited pane', () => {
  // A drag sends the host a size a frame. A pane whose page lays out slower
  // than that was sent them faster than it could take them, and laid out
  // every one, a frame each, seconds after the drag stopped. A pane that
  // says it has painted a size (`pane-sized`) is sent one at a time, and
  // the newest the host has come to in the meantime.
  async function mountPane() {
    const app = createMockApp();
    app.createPaneHost = () => ({ setRect() {}, present() {}, destroy() {} });
    const listeners = [];
    const rects = [];
    const sent = [];
    const transport = () => ({
      send(msg) {
        sent.push(msg);
        if (msg?.type === 'pane-rect') rects.push(msg.width);
      },
      onMessage: (cb) => {
        listeners.push(cb);
        setImmediate(() => cb({ type: 'ready', windowId: 1 }));
        return () => listeners.splice(listeners.indexOf(cb) >>> 0, 1);
      },
      onExit: () => () => {},
      pid: -1,
    });
    const frame = h(Frame, {
      key: 'pane',
      src: PANE,
      transport,
      style: { flexGrow: 1 },
    });
    const root = await createRoot({ app });
    const resize = async (width) => {
      root.render(h('window', { width, height: 120 }, frame));
      await settle();
      flushFrames(app.windows[0]);
    };
    await resize(200);
    const fromPane = (msg) => {
      for (const cb of [...listeners]) cb(msg);
    };
    return { root, rects, resize, fromPane, sent, wnd: app.windows[0] };
  }

  it('a pane that never says it has painted a size is sent every one', async () => {
    const { root, rects, resize } = await mountPane();
    await resize(180);
    await resize(160);
    assert.deepEqual(rects, [200, 180, 160]);
    await root.unmount();
  });

  it('one that does is sent one at a time, and the newest when it has painted', async () => {
    const { root, rects, resize, fromPane } = await mountPane();
    fromPane({ type: 'pane-sized' });
    await resize(140);
    await resize(120);
    await resize(100);
    assert.deepEqual(rects, [200, 140], 'nothing more until 140 is painted');
    fromPane({ type: 'pane-sized' });
    assert.deepEqual(rects, [200, 140, 100], 'then the newest, past 120');
    fromPane({ type: 'pane-sized' });
    assert.deepEqual(rects, [200, 140, 100], 'and nothing when none waits');
    await root.unmount();
  });

  it('a pane hears its window is resized live, with every size and on its own when only that changes', async () => {
    // A pane has no window of its own for AppKit to bracket a drag of: it
    // is told, so core defers its content floors for the drag's length and
    // an element can put off what it would do once the drag ends
    const { root, resize, sent, wnd } = await mountPane();
    const live = () => sent.filter((m) => m.type === 'pane-live');
    assert.equal(sent.find((m) => m.type === 'pane-rect').live, false);
    wnd.liveResizing = true;
    wnd.emit('liveresize', { live: true });
    assert.deepEqual(live(), [{ type: 'pane-live', live: true }]);
    await resize(180);
    assert.equal(sent.findLast((m) => m.type === 'pane-rect').live, true);
    wnd.liveResizing = false;
    wnd.emit('liveresize', { live: false });
    assert.deepEqual(live().at(-1), { type: 'pane-live', live: false });
    await root.unmount();
  });

  it('a drag that comes back to the size out waits for nothing', async () => {
    const { root, rects, resize, fromPane } = await mountPane();
    fromPane({ type: 'pane-sized' });
    await resize(150);
    await resize(130);
    await resize(150);
    fromPane({ type: 'pane-sized' });
    assert.deepEqual(rects, [200, 150]);
    await root.unmount();
  });

  it('one that goes quiet is sent the newest anyway', async () => {
    const { root, rects, resize, fromPane } = await mountPane();
    fromPane({ type: 'pane-sized' });
    await resize(150);
    await resize(110);
    assert.deepEqual(rects, [200, 150]);
    await new Promise((r) => setTimeout(r, PANE_SIZED_WAIT_MS + 100));
    assert.deepEqual(rects, [200, 150, 110]);
    await root.unmount();
  });
});
