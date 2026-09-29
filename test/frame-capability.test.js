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
import { createMockApp, spinWheel } from './helpers/mock-app.js';

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
    app.windows[0].flushFrame?.();
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
});
