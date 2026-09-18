// The Windows window's frame contract, against a fake bridge — so it runs on
// every OS, which is the point: this half of the backend is where the bugs
// that made a window come up blank actually lived, and none of them needed a
// GPU to reproduce.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Win32Window } from '../../src/win32/window.js';
import { createFakeApp, createFakeBridge } from './fake-bridge.js';

/** A node stand-in: records the regions it was asked to paint, and draws
 * something into each so the frame is not trivially empty. */
function fakeNode() {
  const painted = [];
  return {
    painted,
    _paintRegion(ctx, rect) {
      painted.push(rect);
      ctx.fillStyle = '#123456';
      ctx.fillRect(0, 0, 10, 10);
    },
  };
}

function setup({ width = 200, height = 100 } = {}) {
  const bridge = createFakeBridge();
  const app = createFakeApp(bridge);
  const wnd = new Win32Window(app, { width, height, title: 'test' });
  return { bridge, app, wnd };
}

describe('win32 window: the frame', () => {
  it('drops a frame before composition and owes a full one for it', () => {
    const { bridge, wnd } = setup();
    const node = fakeNode();

    // The tree mounts, lays out and paints in the same turn the window is
    // asked for, so this lands before the HWND exists.
    wnd.presentFrame(node, [{ x: 0, y: 0, width: 200, height: 100 }]);
    assert.equal(bridge.drawn.length, 0, 'painted with nothing to paint into');
    assert.equal(node.painted.length, 0);

    wnd._onReady();

    // The next frame carries a *narrow* damage list — which is what a tree
    // with an animation in it produces — and must be widened anyway, or the
    // background is never painted and the window stays transparent.
    wnd.presentFrame(node, [{ x: 50, y: 40, width: 20, height: 14 }]);
    assert.deepEqual(
      bridge.drawn,
      [[0, 0, 200, 100]],
      'the owed frame did not repaint the whole window',
    );
    assert.deepEqual(node.painted, [null], 'the paint pass was still bounded');
  });

  it('owes the full frame only once', () => {
    const { bridge, wnd } = setup();
    const node = fakeNode();
    wnd.presentFrame(node, [{ x: 0, y: 0, width: 200, height: 100 }]);
    wnd._onReady();
    wnd.presentFrame(node, [{ x: 50, y: 40, width: 20, height: 14 }]);
    bridge.drawn.length = 0;

    wnd.presentFrame(node, [{ x: 10, y: 10, width: 30, height: 12 }]);
    assert.deepEqual(
      bridge.drawn,
      [[10, 10, 30, 12]],
      'the window kept repainting everything after the debt was paid',
    );
  });

  it('opens one BeginDraw per damage rect, and commits once', () => {
    const { bridge, wnd } = setup();
    const node = fakeNode();
    wnd._onReady();
    bridge.drawn.length = 0;
    bridge.committed = 0;

    wnd.presentFrame(node, [
      { x: 0, y: 0, width: 20, height: 10 },
      { x: 100, y: 50, width: 30, height: 20 },
    ]);

    assert.deepEqual(bridge.drawn, [
      [0, 0, 20, 10],
      [100, 50, 30, 20],
    ]);
    assert.equal(bridge.committed, 1, 'a frame is one commit, whatever its rects');
    assert.equal(node.painted.length, 2);
  });

  it('bumps the surface generation per rect, so the context resyncs', () => {
    const { wnd } = setup();
    const node = fakeNode();
    wnd._onReady();

    const before = wnd._gen;
    wnd.presentFrame(node, [
      { x: 0, y: 0, width: 20, height: 10 },
      { x: 30, y: 0, width: 20, height: 10 },
    ]);
    // Each BeginDraw hands back a different Direct2D context with none of the
    // previous one's state; the generation is how BackendContext2D is told.
    assert.equal(wnd._gen, before + 2);
  });

  it('closes the frame even when the paint pass throws', () => {
    const { bridge, wnd } = setup();
    wnd._onReady();
    const exploding = {
      _paintRegion() {
        throw new Error('boom');
      },
    };
    assert.throws(() => wnd.presentFrame(exploding, null), /boom/);
    assert.equal(bridge.open.size, 0, 'a surface was left open');
    assert.equal(wnd._surface, 0, 'the window still points at a dead surface');
  });

  it('clamps a damage rect to the window, since a surface refuses one outside it', () => {
    const { bridge, wnd } = setup({ width: 200, height: 100 });
    const node = fakeNode();
    wnd._onReady();
    bridge.drawn.length = 0;

    // A claim can reach past the window — a node moved, a shadow grew — and
    // the real surface answers a rect outside its bounds with a refusal.
    wnd.presentFrame(node, [{ x: 180, y: 90, width: 60, height: 60 }]);
    assert.deepEqual(bridge.drawn, [[180, 90, 20, 10]]);
  });

  it('shows only once the HWND exists, and remembers it was asked', () => {
    const { bridge, wnd } = setup();
    wnd.map();
    assert.equal(bridge.windows.get(wnd.id).shown, false, 'shown a window with no HWND');
    wnd._onReady();
    assert.equal(bridge.windows.get(wnd.id).shown, true);
  });

  it('records a resize with no surface yet, so compose uses the size it became', () => {
    const { bridge, wnd } = setup({ width: 200, height: 100 });
    // An auto-sized window is measured and resized before its HWND exists.
    wnd.resize(640, 480);
    assert.equal(bridge.windows.get(wnd.id).width, 640);
    assert.equal(bridge.windows.get(wnd.id).height, 480);

    wnd._onReady();
    const node = fakeNode();
    wnd.presentFrame(node, null);
    assert.deepEqual(
      bridge.drawn.at(-1),
      [0, 0, 640, 480],
      'the frame was painted at the size the window was asked for, not the one it became',
    );
  });
});

describe('win32 window: what it refuses honestly', () => {
  it('reports no frame in flight — DirectComposition holds none', () => {
    const { wnd } = setup();
    assert.equal(wnd.frameInFlight(), false);
  });

  it('refuses a snapshot rather than answering with something wrong', async () => {
    const { wnd } = setup();
    await assert.rejects(() => wnd.snapshot(), /cannot snapshot/);
  });

  it('resolves setWmState false rather than latching a true it did not apply', async () => {
    const { wnd } = setup();
    assert.equal(await wnd.setWmState(['fullscreen']), false);
    assert.deepEqual(await wnd.getWmStates(), []);
  });
});
