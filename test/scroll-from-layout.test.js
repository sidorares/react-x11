// `onScroll` for the offsets a layout pass moves rather than a call:
// `scrollIntoView` resolving against the geometry the pass produced, and the
// clamp that pulls an offset back when the content shrinks, or the viewport
// grows, under it. A browser fires `scroll` for both. Neither happens inside
// anything the app called, so the report is deferred past the pass, the way
// `onViewport` and `onLayout` are, and reads its payload when it is
// delivered. The immediate routes (the wheel, the keys, a bar, `scrollTo`,
// `scrollBy`) still report inside the call.
//
// Production scheduling throughout (createMockApp + createRoot, setImmediate
// ticks, no act), because what is asserted is which frame shows what, and
// when the handler hears of it.
import { test } from 'node:test';
import assert from 'node:assert';
import React, { useLayoutEffect } from 'react';
import { createRoot } from '../src/index.js';
import { hooks } from '../src/trace-registry.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
// the commit, the frame it schedules, and the reports deferred past it
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/**
 * One scroll pane over `count` rows, in a window. The defaults are the
 * repro: a 100px pane over three 80px rows, 240 of content, so the furthest
 * it scrolls is 140. `effect(pane, rows)` runs from a mount-time layout
 * effect, before the pane has been laid out.
 *
 * `frames` is the pane's `scrollY` (device pixels) as each painted frame
 * left it (the tracer's `frame` hook, which runs after the paint), and
 * `scrolls` is every `onScroll`, with how many frames had painted when it
 * arrived and the `tag` of the render whose handler heard it; a render with
 * `tag: null` has no handler at all. `nextFrame` runs once, right after the
 * next frame paints: after that frame's layout pass, before anything the
 * pass deferred. `errors` collects what the handler reporting caught.
 */
async function mount(
  t,
  {
    effect,
    count = 3,
    size = { width: 200, height: 100 },
    pane = { height: 100 },
    row = () => ({ height: 80, flexShrink: 0 }),
    scale = 1,
    errors,
  } = {},
) {
  const app = createMockApp();
  const options = { app };
  if (scale !== 1) options.scale = scale;
  if (errors) {
    options.onUncaughtError = (error, info) =>
      errors.push(`${info?.handler}: ${error?.message}`);
  }
  const x11Root = await createRoot(options);
  const ref = React.createRef();
  const rows = [];
  const m = {
    x11Root,
    rows,
    frames: [],
    scrolls: [],
    nextFrame: null,
    get pane() {
      return ref.current;
    },
    async render(props) {
      x11Root.render(h('window', size, h(Pane, props)));
      await settle();
    },
  };
  function Pane({ count, tag }) {
    useLayoutEffect(() => {
      effect?.(ref.current, rows);
    }, []);
    return h(
      'box',
      {
        ref,
        style: { overflow: 'scroll', ...pane },
        onScroll:
          tag === null
            ? undefined
            : (ev) => m.scrolls.push({ ev, frames: m.frames.length, tag }),
      },
      ...Array.from({ length: count }, (_, i) =>
        h('box', {
          key: i,
          ref: (node) => {
            rows[i] = node;
          },
          style: row(i),
        }),
      ),
    );
  }
  const outer = hooks.frame;
  hooks.frame = () => {
    m.frames.push(ref.current?.scrollY);
    const next = m.nextFrame;
    m.nextFrame = null;
    next?.();
  };
  t.after(async () => {
    hooks.frame = outer;
    await x11Root.unmount();
  });
  await m.render({ count });
  m.wnd = app.windows[0];
  return m;
}

for (const scale of [1, 2]) {
  test(`a scrollIntoView from a mount-time layout effect reports where the pass took the pane (scale ${scale})`, async (t) => {
    const m = await mount(t, {
      effect: (pane, rows) => pane.scrollIntoView(rows[2]),
      scale,
    });
    assert.strictEqual(
      m.pane.scrollY,
      140 * scale,
      'the third row brought into view: 240 - 100',
    );
    assert.deepStrictEqual(
      m.scrolls.map((s) => s.ev),
      [
        {
          scrollX: 0,
          scrollY: 140,
          contentWidth: 200,
          contentHeight: 240,
          viewportWidth: 200,
          viewportHeight: 100,
        },
      ],
      'once, in logical pixels, with the sizes the pass measured',
    );
    assert.strictEqual(m.frames[0], 140 * scale, 'the first frame shows it');
    assert.ok(
      m.scrolls[0].frames >= 1,
      'and the report comes after that frame, not inside the pass',
    );
  });
}

test('a scrollIntoView on a laid-out pane reports once the pass has moved it, and not when it had nowhere to go', async (t) => {
  const m = await mount(t);
  assert.deepStrictEqual(m.scrolls, [], 'a mount at the top moved nothing');
  m.pane.scrollIntoView(m.rows[2]);
  assert.deepStrictEqual(
    m.scrolls,
    [],
    'the call moves nothing: the pass does',
  );
  await settle();
  assert.strictEqual(m.pane.scrollY, 140);
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev.scrollY),
    [140],
  );

  // already fully in view, so the pass leaves the offset where it is
  m.pane.scrollIntoView(m.rows[2]);
  await settle();
  assert.strictEqual(m.pane.scrollY, 140);
  assert.strictEqual(m.scrolls.length, 1, 'nothing moved, nothing to report');

  // and back towards the start: the least that shows the first row is its top
  m.pane.scrollIntoView(m.rows[0]);
  await settle();
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev.scrollY),
    [140, 0],
  );
});

for (const direction of ['ltr', 'rtl']) {
  test(`on the x axis, counted from the start edge (${direction})`, async (t) => {
    // three 120px cells in a row, in a 200px pane: 360 across, 160 to
    // scroll, with the third cell's far edge at the content's far end
    const m = await mount(t, {
      pane: { height: 100, flexDirection: 'row', direction },
      row: () => ({ width: 120, flexShrink: 0 }),
    });
    m.pane.scrollIntoView(m.rows[2]);
    await settle();
    assert.strictEqual(m.pane.scrollX, 160);
    assert.deepStrictEqual(
      m.scrolls.map((s) => s.ev),
      [
        {
          scrollX: 160,
          scrollY: 0,
          contentWidth: 360,
          contentHeight: 100,
          viewportWidth: 200,
          viewportHeight: 100,
        },
      ],
    );
  });
}

test('the clamp reports where it left the pane when the content shrinks under the offset', async (t) => {
  const m = await mount(t);
  m.pane.scrollTo(50);
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev.scrollY),
    [50],
    'the scrollTo reported inside the call',
  );

  // 160 of content: 60 to scroll, still past 50, so the offset stands
  await m.render({ count: 2 });
  assert.strictEqual(m.pane.scrollY, 50);
  assert.strictEqual(
    m.scrolls.length,
    1,
    'the content shrank, but not under the offset',
  );

  // 80 of content in a 100px pane: nothing left to scroll
  await m.render({ count: 1 });
  assert.strictEqual(m.pane.scrollY, 0);
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev),
    [
      {
        scrollX: 0,
        scrollY: 50,
        contentWidth: 200,
        contentHeight: 240,
        viewportWidth: 200,
        viewportHeight: 100,
      },
      {
        scrollX: 0,
        scrollY: 0,
        contentWidth: 200,
        contentHeight: 80,
        viewportWidth: 200,
        viewportHeight: 100,
      },
    ],
  );
});

test('so does the clamp when the viewport grows past what is left below the offset', async (t) => {
  const m = await mount(t, { pane: { flexGrow: 1 } });
  m.pane.scrollTo(140);
  await settle();
  // a 200px pane over 240 of content goes 40 down at most
  m.wnd.width = 200;
  m.wnd.height = 200;
  m.wnd.emit('resize', { width: 200, height: 200 });
  await settle();
  assert.strictEqual(m.pane.scrollY, 40);
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev),
    [
      {
        scrollX: 0,
        scrollY: 140,
        contentWidth: 200,
        contentHeight: 240,
        viewportWidth: 200,
        viewportHeight: 100,
      },
      {
        scrollX: 0,
        scrollY: 40,
        contentWidth: 200,
        contentHeight: 240,
        viewportWidth: 200,
        viewportHeight: 200,
      },
    ],
  );
});

test('the payload is read when the report is delivered, not when the pass queued it', async (t) => {
  // A scroll landing between the frame and the report (a wheel notch, a
  // key) has already reported where it went, and a payload from the pass
  // would leave the handler behind the pane.
  const m = await mount(t);
  m.pane.scrollIntoView(m.rows[2]);
  m.nextFrame = () => m.pane.scrollTo(100);
  await settle();
  assert.strictEqual(m.pane.scrollY, 100);
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev.scrollY),
    [100, 100],
    "the scrollTo inside its call, then the pass's report, read on delivery",
  );
});

test('the handler that hears it is the one in the props when it is delivered', async (t) => {
  // React may commit between the pass and the report, and a new handler
  // takes the report; a pane that has dropped its handler reports nothing
  const errors = [];
  const m = await mount(t, { errors });
  m.pane.scrollIntoView(m.rows[2]);
  let rendered;
  // a microtask queued after the frame runs before the next setImmediate
  m.nextFrame = () =>
    queueMicrotask(() => {
      rendered = m.render({ count: 3, tag: 'new' });
    });
  await settle();
  await rendered;
  assert.deepStrictEqual(
    m.scrolls.map((s) => [s.tag, s.ev.scrollY]),
    [['new', 140]],
  );

  m.pane.scrollIntoView(m.rows[0]);
  m.nextFrame = () =>
    queueMicrotask(() => {
      rendered = m.render({ count: 3, tag: null });
    });
  await settle();
  await rendered;
  assert.strictEqual(m.pane.scrollY, 0, 'the pass did move it');
  assert.strictEqual(m.scrolls.length, 1, 'with no handler left, no report');
  assert.deepStrictEqual(errors, [], 'and nothing called in its place');
});

test('a pane unmounted before its report is due hears nothing', async (t) => {
  const m = await mount(t);
  m.pane.scrollIntoView(m.rows[2]);
  let unmounted;
  // after the frame, before the report: a microtask queued there runs
  // before the next setImmediate does
  m.nextFrame = () =>
    queueMicrotask(() => {
      unmounted = m.x11Root.unmount();
    });
  await settle();
  await unmounted;
  assert.strictEqual(m.frames.length, 2, 'the pass did run and paint');
  assert.deepStrictEqual(m.scrolls, []);
});

test('a scrollTo on a laid-out pane still reports inside the call, and the pass after it adds nothing', async (t) => {
  // big enough for the blit's area gate: a 400x400 pane over 20 rows of 40
  const m = await mount(t, {
    size: { width: 400, height: 400 },
    pane: { flexGrow: 1 },
    row: () => ({ height: 40, flexShrink: 0 }),
    count: 20,
  });
  m.wnd.calls.length = 0;
  m.pane.scrollTo(48);
  assert.deepStrictEqual(
    m.scrolls.map((s) => s.ev),
    [
      {
        scrollX: 0,
        scrollY: 48,
        contentWidth: 400,
        contentHeight: 800,
        viewportWidth: 400,
        viewportHeight: 400,
      },
    ],
    'reported inside the call',
  );
  assert.deepStrictEqual(
    m.pane._pendingBlitFrom,
    { x: 0, y: 0 },
    'armed from the offsets on screen',
  );
  await settle();
  assert.deepStrictEqual(
    m.wnd.calls.filter(([name]) => name === 'scrollRegion'),
    [['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -48]],
    'the frame blitted',
  );
  assert.strictEqual(
    m.scrolls.length,
    1,
    'and the pass that laid it out moved nothing further',
  );
});
