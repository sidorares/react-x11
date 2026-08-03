// The hot pointer path (issue #188): paint order is cached and re-verified
// per read, and hitTest culls whole subtrees on cached hit bounds. The cache
// rules these tests pin:
//
//  - the hit-bounds cache may only ever be a *superset* of the true reach,
//    so every test here warms it first and then mutates — a missing
//    invalidation shows up as a miss on input that should land;
//  - the paint-order cache is verified against the live children on every
//    read, so order, zIndex and visibility changes take effect on the very
//    next event with no invalidation hook to forget.
import { test } from 'node:test';
import assert from 'node:assert';
import React from 'react';
import { createRoot } from '../src/index.js';

import { createMockApp, moveMouse, pressButton } from './helpers/mock-app.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
// A bare setState is default-priority work: React schedules the render a
// few macrotasks out (observed: three), unlike the event-driven updates the
// rest of the suite makes, which discrete dispatch flushes synchronously.
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/** Mount `body(state)` inside a fixed window; returns setState. */
async function mountStateful(x11Root, body) {
  let setState;
  function App() {
    const [state, set] = React.useState(0);
    setState = set;
    return React.createElement(
      'window',
      { width: 400, height: 400 },
      body(state),
    );
  }
  x11Root.render(React.createElement(App));
  await tick();
  return { setState: (v) => setState(v) };
}

test('hitSlop reaches outside every ancestor rect, through the culled walk', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const host = React.createRef();
    const target = React.createRef();
    await mountStateful(x11Root, () =>
      // a 10x10 host whose absolutely-positioned child sits far outside it,
      // with slop growing the child's target beyond its own rect: the cull
      // must include both hops or the tap is dropped
      React.createElement(
        'box',
        {
          ref: host,
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            width: 10,
            height: 10,
          },
        },
        React.createElement('box', {
          ref: target,
          style: {
            position: 'absolute',
            left: 100,
            top: 100,
            width: 30,
            height: 30,
            hitSlop: 8,
          },
        }),
      ),
    );
    const root = host.current.root;

    assert.ok(root.hitTest(105, 105) === target.current, 'inside the box');
    assert.ok(
      root.hitTest(95, 95) === target.current,
      'inside the slop ring, outside the box and every ancestor rect',
    );
    assert.ok(
      root.hitTest(300, 300) === root,
      'far away resolves to the window itself',
    );
  } finally {
    await x11Root.unmount();
  }
});

test('a hitSlop that grows after the cache warmed still lands taps', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const target = React.createRef();
    const { setState } = await mountStateful(x11Root, (state) =>
      React.createElement('box', {
        ref: target,
        style: {
          position: 'absolute',
          left: 100,
          top: 100,
          width: 20,
          height: 20,
          hitSlop: state ? 12 : 0,
        },
      }),
    );
    const root = target.current.root;

    // warm the cached bounds with the slopless style
    assert.ok(root.hitTest(95, 95) === root, 'no slop yet');
    setState(1);
    await settle();
    assert.ok(
      root.hitTest(95, 95) === target.current,
      'the grown slop is hittable on the next event',
    );
  } finally {
    await x11Root.unmount();
  }
});

test('a node layout moves away from warmed bounds and is hit at its new rect', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const box = React.createRef();
    const { setState } = await mountStateful(x11Root, (state) =>
      React.createElement('box', {
        ref: box,
        style: {
          position: 'absolute',
          left: state ? 140 : 20,
          top: 40,
          width: 40,
          height: 40,
        },
      }),
    );
    const root = box.current.root;

    assert.ok(root.hitTest(30, 50) === box.current, 'at the old rect');
    setState(1);
    await settle();
    assert.ok(root.hitTest(150, 50) === box.current, 'at the new rect');
    assert.ok(root.hitTest(30, 50) === root, 'the old rect is vacated');
  } finally {
    await x11Root.unmount();
  }
});

test('scrolling re-aims the pointer at the row that moved under it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const sv = React.createRef();
    const rows = Array.from({ length: 10 }, () => React.createRef());
    await mountStateful(x11Root, () =>
      React.createElement(
        'scrollview',
        { ref: sv, style: { width: 200, height: 100 } },
        rows.map((ref, i) =>
          React.createElement('box', {
            key: i,
            ref,
            style: { height: 40 },
          }),
        ),
      ),
    );
    const root = sv.current.root;

    assert.ok(root.hitTest(50, 50) === rows[1].current, 'row 1 at y=50');
    sv.current.scrollBy({ x: 0, y: 80 });
    await tick();
    assert.ok(
      root.hitTest(50, 50) === rows[3].current,
      'after an 80px scroll the same point is row 3',
    );
  } finally {
    await x11Root.unmount();
  }
});

test('a keyed reorder flips which overlapping sibling is on top', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const a = React.createRef();
    const b = React.createRef();
    const overlap = {
      position: 'absolute',
      left: 0,
      top: 0,
      width: 50,
      height: 50,
    };
    const { setState } = await mountStateful(x11Root, (state) => {
      const A = React.createElement('box', {
        key: 'a',
        ref: a,
        style: overlap,
      });
      const B = React.createElement('box', {
        key: 'b',
        ref: b,
        style: overlap,
      });
      return state ? [B, A] : [A, B];
    });
    const root = a.current.root;

    assert.ok(root.hitTest(10, 10) === b.current, 'later sibling wins');
    setState(1);
    await settle();
    assert.ok(
      root.hitTest(10, 10) === a.current,
      'the reorder moved A later in document order, so A wins',
    );
  } finally {
    await x11Root.unmount();
  }
});

test('a zIndex change reorders hits on the very next event', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const a = React.createRef();
    const b = React.createRef();
    const { setState } = await mountStateful(x11Root, (state) => [
      React.createElement('box', {
        key: 'a',
        ref: a,
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 50,
          height: 50,
          zIndex: state ? 2 : 0,
        },
      }),
      React.createElement('box', {
        key: 'b',
        ref: b,
        style: { position: 'absolute', left: 0, top: 0, width: 50, height: 50 },
      }),
    ]);
    const root = a.current.root;

    assert.ok(root.hitTest(10, 10) === b.current, 'document order first');
    setState(1);
    await settle();
    assert.ok(root.hitTest(10, 10) === a.current, 'zIndex 2 wins');
    setState(0);
    await settle();
    assert.ok(root.hitTest(10, 10) === b.current, 'and back');
  } finally {
    await x11Root.unmount();
  }
});

test('display: none removes a node from hits, and its lifting restores it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const top = React.createRef();
    const under = React.createRef();
    const { setState } = await mountStateful(x11Root, (state) => [
      React.createElement('box', {
        key: 'under',
        ref: under,
        style: { position: 'absolute', left: 0, top: 0, width: 60, height: 60 },
      }),
      React.createElement('box', {
        key: 'top',
        ref: top,
        style: {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 60,
          height: 60,
          display: state ? 'none' : 'flex',
        },
      }),
    ]);
    const root = top.current.root;

    assert.ok(root.hitTest(10, 10) === top.current, 'top is hit first');
    setState(1);
    await settle();
    assert.ok(
      root.hitTest(10, 10) === under.current,
      'display:none drops out of hit testing',
    );
    setState(0);
    await settle();
    assert.ok(root.hitTest(10, 10) === top.current, 'restored');
  } finally {
    await x11Root.unmount();
  }
});

test('the cull skips subtrees the pointer is nowhere near', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const first = React.createRef();
    // 20 rows of 10 leaves under a non-clipping container: 232 nodes
    await mountStateful(x11Root, () =>
      React.createElement(
        'box',
        { style: { flexGrow: 1 } },
        Array.from({ length: 20 }, (_, r) =>
          React.createElement(
            'box',
            { key: r, style: { height: 20, flexDirection: 'row' } },
            Array.from({ length: 10 }, (_, c) =>
              React.createElement('box', {
                key: c,
                ref: r === 0 && c === 0 ? first : undefined,
                style: { width: 20 },
              }),
            ),
          ),
        ),
      ),
    );
    const root = first.current.root;

    // count hitTest entries by patching the prototype that owns it
    let proto = first.current;
    while (proto && !Object.hasOwn(proto, 'hitTest')) {
      proto = Object.getPrototypeOf(proto);
    }
    const original = proto.hitTest;
    let visits = 0;
    proto.hitTest = function (x, y) {
      visits++;
      return original.call(this, x, y);
    };
    try {
      assert.ok(root.hitTest(5, 5) === first.current, 'the leaf is hit');
      // every sibling row is entered once and culled without touching its
      // leaves: well under the 232 nodes a full walk visits
      assert.ok(
        visits <= 60,
        `expected the bounds cull to skip far subtrees, visited ${visits}`,
      );
    } finally {
      proto.hitTest = original;
    }
  } finally {
    await x11Root.unmount();
  }
});

test('dispatch runs capture then bubble with per-dispatch keys and one event', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const inner = React.createRef();
    const calls = [];
    let captureEv = null;
    let bubbleEv = null;
    function App() {
      return React.createElement(
        'window',
        {
          width: 400,
          height: 400,
          onMouseDownCapture: (ev) => {
            captureEv = ev;
            calls.push(['window capture', ev.currentTarget]);
          },
          onMouseDown: (ev) => calls.push(['window bubble', ev.currentTarget]),
        },
        React.createElement('box', {
          ref: inner,
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            width: 50,
            height: 50,
          },
          onMouseDown: (ev) => {
            bubbleEv = ev;
            calls.push(['box bubble', ev.currentTarget]);
          },
        }),
      );
    }
    x11Root.render(React.createElement(App));
    await tick();
    const wnd = app.windows[0];

    pressButton(wnd, 10, 10, { release: false });
    assert.deepStrictEqual(
      calls.map(([name]) => name),
      ['window capture', 'box bubble', 'window bubble'],
    );
    assert.ok(captureEv === bubbleEv, 'one event object end to end');
    assert.ok(bubbleEv.target === inner.current, 'target is the box node');
    assert.strictEqual(bubbleEv.type, 'mouseDown');
    assert.strictEqual(bubbleEv.button, 1);
    assert.strictEqual(bubbleEv.localX, 10);
  } finally {
    await x11Root.unmount();
  }
});

test('capturePointer routes moves to the captor; releasePointer hands back', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const grabber = React.createRef();
    const moves = [];
    const otherMoves = [];
    function App() {
      return React.createElement('window', { width: 400, height: 400 }, [
        React.createElement('box', {
          key: 'grab',
          ref: grabber,
          style: {
            position: 'absolute',
            left: 0,
            top: 0,
            width: 50,
            height: 50,
          },
          onMouseDown: (ev) => ev.capturePointer(),
          onMouseMove: (ev) => {
            moves.push(ev.x);
            if (moves.length === 2) ev.releasePointer();
          },
        }),
        React.createElement('box', {
          key: 'other',
          style: {
            position: 'absolute',
            left: 200,
            top: 0,
            width: 50,
            height: 50,
          },
          onMouseMove: (ev) => otherMoves.push(ev.x),
        }),
      ]);
    }
    x11Root.render(React.createElement(App));
    await tick();
    const wnd = app.windows[0];

    pressButton(wnd, 10, 10, { release: false });
    moveMouse(wnd, 220, 10); // over 'other', but captured
    moveMouse(wnd, 230, 10); // still captured; handler releases here
    moveMouse(wnd, 240, 10); // released: goes to 'other'
    assert.deepStrictEqual(
      moves,
      [220, 230],
      'captured moves reach the captor',
    );
    assert.deepStrictEqual(otherMoves, [240], 'after release, hits rule again');
  } finally {
    await x11Root.unmount();
  }
});

test('key events prefer ntk-decoded baseKeysym, fall back to the keymap', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  try {
    const seen = [];
    function App() {
      return React.createElement('window', {
        width: 400,
        height: 400,
        onKeyDown: (ev) => seen.push(ev.keysym),
      });
    }
    x11Root.render(React.createElement(App));
    await tick();
    const wnd = app.windows[0];

    // decorated event, the way ntk delivers keys: baseKeysym wins even when
    // the raw keymap disagrees (a shifted key reports its level-0 sym there)
    app.X.keycode2keysyms[30] = [0x71]; // 'q'
    wnd.emit('keydown', { keycode: 30, baseKeysym: 0xff09, buttons: 0 });
    // undecorated event, the way mocks and older ntk deliver them
    wnd.emit('keydown', { keycode: 30, buttons: 0 });
    assert.deepStrictEqual(seen, [0xff09, 0x71]);
  } finally {
    await x11Root.unmount();
  }
});
