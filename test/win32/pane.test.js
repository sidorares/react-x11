// A `<Frame>`'s two halves on the Windows backend — the decisions that are
// this backend's rather than the element's, and that are invisible when they
// go wrong.
//
// The pixels themselves are the bridge's business and its own test reads
// them back off a real window (`windows/test/pane.js`). What lives here is
// everything that would still compile, still present and still look plausible
// while being wrong: which region a frame paints, when the buffer handle is
// published, and how often the host attaches it.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Win32PaneHost } from '../../src/win32/panehost.js';
import { Win32PaneWindow } from '../../src/win32/panewindow.js';
import { createFakeApp, createFakeBridge } from './fake-bridge.js';

/** A node stand-in that records the region each frame asked it to paint. */
function fakeNode() {
  const painted = [];
  return {
    painted,
    _paintRegion(ctx, rect) {
      painted.push(rect ? { ...rect } : null);
    },
  };
}

function makePane({ width = 200, height = 100, scale = 1 } = {}) {
  const bridge = createFakeBridge();
  const app = createFakeApp(bridge, { scale });
  const wnd = new Win32PaneWindow(app, { width, height });
  return { bridge, app, wnd, node: fakeNode() };
}

const rect = (x, y, width, height) => ({ x, y, width, height });

describe('win32 pane: which region a frame paints', () => {
  it('paints the whole pane until the buffers have been through the chain', () => {
    const { wnd, node } = makePane();
    wnd.presentFrame(node, [rect(10, 10, 20, 20)]);
    wnd.presentFrame(node, [rect(50, 50, 10, 10)]);
    // A flip chain's back buffer starts undefined and is only known-good
    // once every buffer in it has been painted whole.
    assert.deepEqual(node.painted, [null, null]);
  });

  it('paints this frame damage and the last frame, because the buffer is two frames old', () => {
    const { wnd, node } = makePane();
    wnd.presentFrame(node, [rect(0, 0, 1, 1)]); // full: standing start
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]); // full: ditto
    node.painted.length = 0;

    wnd.presentFrame(node, [rect(60, 60, 10, 10)]);
    // The buffer this frame was handed last held frame 2, so frame 3 owes
    // frame 3's damage *and* frame 2's — 10,10..20,20 with 60,60..70,70.
    assert.deepEqual(node.painted, [rect(10, 10, 60, 60)]);

    node.painted.length = 0;
    wnd.presentFrame(node, [rect(80, 80, 5, 5)]);
    assert.deepEqual(node.painted, [rect(60, 60, 25, 25)]);
  });

  it('paints one pass, not one per rect — a second pass over a pixel composites it twice', () => {
    const { wnd, node } = makePane();
    wnd.presentFrame(node, null);
    wnd.presentFrame(node, [rect(0, 0, 1, 1)]); // still full: the one after
    node.painted.length = 0;
    wnd.presentFrame(node, [rect(0, 0, 10, 10), rect(90, 90, 10, 10)]);
    assert.equal(node.painted.length, 1);
    assert.deepEqual(node.painted[0], rect(0, 0, 100, 100));
  });

  it('an unbounded frame anywhere in the window makes the union unbounded', () => {
    const { wnd, node } = makePane();
    wnd.presentFrame(node, null);
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]);
    node.painted.length = 0;
    // the previous frame was bounded, this one is not
    wnd.presentFrame(node, null);
    assert.deepEqual(node.painted, [null]);
    node.painted.length = 0;
    // …and the one after it inherits that: its buffer holds the full frame
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]);
    assert.deepEqual(node.painted, [null]);
  });

  it('a resize starts the chain over: new buffers hold nothing', () => {
    const { wnd, node, bridge } = makePane();
    // …into the steady state first, where a frame is bounded by its damage
    wnd.presentFrame(node, null);
    wnd.presentFrame(node, null);
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]);
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]);
    assert.deepEqual(node.painted.at(-1), rect(10, 10, 10, 10));

    node.painted.length = 0;
    wnd.setPaneSize(300, 150, 1);
    assert.equal(bridge.panes.get(wnd._pane).width, 300);
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]);
    wnd.presentFrame(node, [rect(10, 10, 10, 10)]);
    assert.deepEqual(
      node.painted,
      [null, null],
      'a resize owes two full frames',
    );
  });

  it('refuses the scroll blit: the band it would move is the wrong picture', () => {
    const { wnd } = makePane();
    assert.equal(wnd.scrollRegion(rect(0, 0, 50, 50), 0, -10), false);
  });

  it('presents once per frame, at the size the pane then had', () => {
    const { wnd, node, bridge } = makePane();
    wnd.presentFrame(node, null);
    wnd.setPaneSize(300, 150, 1);
    wnd.presentFrame(node, null);
    assert.deepEqual(bridge.presented, [
      { width: 200, height: 100 },
      { width: 300, height: 150 },
    ]);
  });

  it('sizes itself in the host display scale, not its own', () => {
    const { wnd, bridge } = makePane({ scale: 1 });
    wnd.setPaneSize(200, 100, 2);
    assert.equal(wnd.width, 400);
    assert.deepEqual(bridge.panes.get(wnd._pane), {
      id: 1,
      width: 400,
      height: 200,
      hostPid: process.ppid,
      handle: 0xf01,
    });
  });
});

describe('win32 pane: publishing the buffer', () => {
  it('says nothing until there is a frame in the buffer', () => {
    const { wnd, app, node } = makePane();
    // A host that is listening before the pane has drawn must not be told to
    // show a buffer with nothing in it.
    wnd.setPaneSize(200, 100, 1);
    assert.deepEqual(app.sent, []);
    wnd.presentFrame(node, null);
    assert.deepEqual(app.sent, [
      { type: 'pane-present', id: 0xf01, width: 200, height: 100 },
    ]);
  });

  it('does not name the handle again every frame — the present is the hand-off', () => {
    const { wnd, app, node } = makePane();
    for (let i = 0; i < 5; i++) wnd.presentFrame(node, null);
    assert.equal(app.sent.length, 1);
  });

  it('names it again on a pane-rect, which is the one message that follows the host being ready', () => {
    const { wnd, app, node } = makePane();
    wnd.presentFrame(node, null);
    app.sent.length = 0;
    // A present sent before the host subscribed is lost, and nothing
    // acknowledges one — so the next rect the host sends is the recovery.
    wnd.setPaneSize(200, 100, 1); // same size: still a pane-rect
    assert.deepEqual(app.sent, [
      { type: 'pane-present', id: 0xf01, width: 200, height: 100 },
    ]);
  });

  it('says why when it cannot reach the host at all', () => {
    const bridge = createFakeBridge();
    bridge.paneCreateFails = true;
    const app = createFakeApp(bridge);
    assert.throws(
      () => new Win32PaneWindow(app, { width: 100, height: 100 }),
      /could not make a buffer to share with its host/,
    );
  });

  it('publishes to the process the host named, over its parent', () => {
    const bridge = createFakeBridge();
    const app = createFakeApp(bridge, { paneHostPid: 4242 });
    const wnd = new Win32PaneWindow(app, { width: 100, height: 100 });
    assert.equal(bridge.panes.get(wnd._pane).hostPid, 4242);
  });
});

describe('win32 pane: the host', () => {
  const hostApp = () => {
    const bridge = createFakeBridge();
    const app = createFakeApp(bridge);
    return { bridge, host: new Win32PaneHost(app, { id: 7 }) };
  };

  it('attaches on the first present and recognises the handle after it', () => {
    const { bridge, host } = hostApp();
    host.setRect(rect(10, 20, 100, 50));
    assert.equal(bridge.views.size, 0, 'nothing to attach before a handle');

    host.present(0xf01);
    host.present(0xf01);
    host.present(0xf01);
    assert.equal(
      bridge.calls.filter(([name]) => name === 'paneAttach').length,
      1,
    );
    assert.deepEqual([...bridge.views.values()][0].rect, {
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it('places a pane it was told about before it had one', () => {
    const { bridge, host } = hostApp();
    host.present(0xf01);
    host.setRect(rect(4, 8, 40, 20));
    assert.deepEqual([...bridge.views.values()][0].rect, {
      x: 4,
      y: 8,
      width: 40,
      height: 20,
    });
  });

  it('carries the size through, because that is what clips the pane', () => {
    const { bridge, host } = hostApp();
    host.present(0xf01);
    host.setRect(rect(0, 0, 80, 60));
    const call = bridge.calls.findLast(([name]) => name === 'paneSetRect');
    assert.deepEqual(call, ['paneSetRect', 1, 0, 0, 80, 60]);
  });

  it('re-attaches a different handle: that is a restarted pane', () => {
    const { bridge, host } = hostApp();
    host.setRect(rect(0, 0, 10, 10));
    host.present(0xf01);
    host.present(0xf02);
    assert.deepEqual(
      bridge.calls.filter(([n]) => n === 'paneAttach' || n === 'paneDetach'),
      [
        ['paneAttach', 7, 0xf01],
        ['paneDetach', 1],
        ['paneAttach', 7, 0xf02],
      ],
    );
    assert.equal(bridge.views.size, 1);
  });

  it('lets go of the visual, and of a present that arrives after it', () => {
    const { bridge, host } = hostApp();
    host.present(0xf01);
    host.destroy();
    assert.equal(bridge.views.size, 0);
    host.present(0xf02);
    host.setRect(rect(0, 0, 10, 10));
    assert.equal(bridge.views.size, 0);
  });

  it('does not re-place a pane that has not moved', () => {
    const { bridge, host } = hostApp();
    host.present(0xf01);
    host.setRect(rect(1, 2, 30, 40));
    const before = bridge.calls.filter(([n]) => n === 'paneSetRect').length;
    host.setRect(rect(1, 2, 30, 40));
    host.setRect({ x: 1, y: 2, width: 30, height: 40 });
    assert.equal(
      bridge.calls.filter(([n]) => n === 'paneSetRect').length,
      before,
    );
  });
});
