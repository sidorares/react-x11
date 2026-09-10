// A `scrollTo` made before a scroll pane's first layout pass. There is no
// extent to clamp against yet (`contentHeight` and `abs` are still zeros),
// so the offset is held and that pass applies it, clamped to what it
// measured, the way `scrollIntoView` resolves its node. Restoring a list's
// position from a mount-time effect is the case this is for; the clamp used
// to turn it into 0. A pane that has been laid out keeps the immediate path:
// the offset moves, `onScroll` fires and the blit arms inside the call.
//
// Production scheduling throughout (createMockApp + createRoot, setImmediate
// ticks, no act), because what is asserted is which frame shows what.
import { test } from 'node:test';
import assert from 'node:assert';
import React, { useLayoutEffect, useState } from 'react';
import { createRoot } from '../src/index.js';
import { hooks } from '../src/trace-registry.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
// the commit, the frame it schedules, and the reports deferred past it
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};
const COLORS = ['#ff0000', '#00ff00', '#0000ff'];

/**
 * Mount one scroll pane and run `effect(pane, cells)` from a mount-time
 * `useLayoutEffect`, before the pane has been laid out. The defaults are the
 * repro: a 100px pane over three 80px rows, 240 of content, so the furthest
 * it scrolls is 140.
 *
 * `frames` is every frame painted during the mount, as the pane and its
 * third cell stood right after it (the tracer's `frame` hook), with that
 * frame's fills; `scrolls` is every `onScroll`, with how many frames had
 * painted when it arrived.
 */
async function mount({
  effect = () => {},
  size = { width: 200, height: 100 },
  pane = { height: 100 },
  cell = (i) => ({ height: 80, flexShrink: 0, backgroundColor: COLORS[i] }),
  count = 3,
} = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  const cells = Array.from({ length: count }, () => React.createRef());
  const frames = [];
  const scrolls = [];
  function Pane() {
    useLayoutEffect(() => {
      effect(
        ref.current,
        cells.map((c) => c.current),
      );
    }, []);
    return h(
      'box',
      {
        ref,
        style: { overflow: 'scroll', ...pane },
        onScroll: (ev) => scrolls.push({ ev, frames: frames.length }),
      },
      ...cells.map((c, i) => h('box', { key: i, ref: c, style: cell(i) })),
    );
  }
  const outer = hooks.frame;
  hooks.frame = () => {
    const third = cells[2].current.abs;
    frames.push({
      scrollX: ref.current.scrollX,
      scrollY: ref.current.scrollY,
      third: { x: third.x, y: third.y },
      fills: app.windows[0].ctx.ops
        .splice(0)
        .filter(([op]) => op === 'fillRect'),
    });
  };
  try {
    x11Root.render(h('window', size, h(Pane)));
    await settle();
  } finally {
    hooks.frame = outer;
  }
  const wnd = app.windows[0];
  return {
    x11Root,
    wnd,
    root: wnd._reactX11Node,
    pane: ref.current,
    cells,
    frames,
    scrolls,
  };
}

test('a scrollTo from a mount-time layout effect is in the first painted frame', async () => {
  const { x11Root, pane, frames } = await mount({
    effect: (p) => p.scrollTo(140),
  });
  const [first] = frames;
  assert.ok(first, 'the window painted');
  assert.strictEqual(first.scrollY, 140, 'the first frame is already scrolled');
  assert.strictEqual(
    first.third.y,
    20,
    'the third row is laid out at 160 - 140',
  );
  assert.ok(
    first.fills.some(([, , y, , , color]) => y === 20 && color === COLORS[2]),
    `and painted there: ${JSON.stringify(first.fills)}`,
  );
  assert.strictEqual(pane.scrollY, 140, 'where it stays');
  await x11Root.unmount();
});

test('a held target past the content clamps to the furthest the pane goes', async () => {
  const { x11Root, frames } = await mount({
    effect: (p) => p.scrollTo(1000),
  });
  assert.strictEqual(frames[0].scrollY, 140, '240 of content in a 100px pane');
  await x11Root.unmount();
});

test('onScroll reports a held scroll once it lands, after the frame that shows it', async () => {
  const { x11Root, scrolls } = await mount({
    effect: (p) => p.scrollTo(1000),
  });
  assert.strictEqual(scrolls.length, 1, 'once');
  assert.deepStrictEqual(
    scrolls[0].ev,
    {
      scrollX: 0,
      scrollY: 140,
      contentWidth: 200,
      contentHeight: 240,
      viewportWidth: 200,
      viewportHeight: 100,
    },
    'with the clamped offset and the sizes the pass measured',
  );
  assert.ok(
    scrolls[0].frames >= 1,
    'deferred past the pass, so it arrives after the frame it painted',
  );
  await x11Root.unmount();

  // the last request wins, and this one leaves the pane where it started:
  // nothing moved, so nothing is reported, as for a scrollTo to the offset
  // a laid-out pane is already at
  const still = await mount({
    effect: (p) => {
      p.scrollTo(140);
      p.scrollTo(0);
    },
  });
  assert.strictEqual(still.frames[0].scrollY, 0);
  assert.deepStrictEqual(still.scrolls, []);
  await still.x11Root.unmount();
});

test('a scrollBy after a held scrollTo moves on from the held offset', async () => {
  const { x11Root, frames } = await mount({
    effect: (p) => {
      p.scrollTo(140);
      p.scrollBy(-40);
    },
  });
  assert.strictEqual(frames[0].scrollY, 100);
  await x11Root.unmount();
});

test('a held scrollTo lands before a scrollIntoView made in the same frame, as on a laid-out pane', async () => {
  // From 140 the second row (80 to 160) is cut off at the top, so bringing
  // it into view scrolls back to its top edge, 80. Resolved in the other
  // order the pane would end at 140.
  const held = await mount({
    effect: (p, cells) => {
      p.scrollTo(140);
      p.scrollIntoView(cells[1]);
    },
  });
  assert.strictEqual(held.frames[0].scrollY, 80);
  await held.x11Root.unmount();

  const laidOut = await mount();
  laidOut.pane.scrollTo(140);
  laidOut.pane.scrollIntoView(laidOut.cells[1].current);
  await settle();
  assert.strictEqual(
    laidOut.pane.scrollY,
    80,
    'the answer a laid-out pane gives',
  );
  await laidOut.x11Root.unmount();
});

for (const direction of ['ltr', 'rtl']) {
  test(`a held scrollTo lands on both axes, and clamps on both (${direction})`, async () => {
    // Three 120x150 cells in a row, in a 200x100 pane: 360x150 of content,
    // 160 to scroll across and 50 down. `scrollX` counts from the start
    // edge, the right-hand one in RTL, where yoga lays the row out leftwards
    // (the third cell at -160) and a growing offset carries it right.
    const rtl = direction === 'rtl';
    const thirdAt = (scrollX) => (rtl ? -160 + scrollX : 240 - scrollX);
    for (const [want, x, y] of [
      [{ x: 100, y: 30 }, 100, 30],
      [{ x: 1000, y: 1000 }, 160, 50],
    ]) {
      const { x11Root, frames } = await mount({
        // one axis per call: the second leaves the first's held axis alone,
        // as it would the offset of a laid-out pane
        effect: (p) => {
          p.scrollTo({ x: want.x });
          p.scrollTo(want.y);
        },
        pane: { height: 100, flexDirection: 'row', direction },
        cell: () => ({ width: 120, height: 150, flexShrink: 0 }),
      });
      const [first] = frames;
      assert.deepStrictEqual(
        { scrollX: first.scrollX, scrollY: first.scrollY, third: first.third },
        { scrollX: x, scrollY: y, third: { x: thirdAt(x), y: -y } },
        `scrollTo({ x: ${want.x} }), then scrollTo(${want.y})`,
      );
      await x11Root.unmount();
    }
  });
}

// A 100px box over three 80px rows whose overflow the test drives, for the
// held request's life across a style that starts or stops scrolling.
const rows = () =>
  Array.from({ length: 3 }, (_, i) =>
    h('box', { key: i, style: { height: 80, flexShrink: 0 } }),
  );

async function mountToggle(Pane) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const render = async (props) => {
    x11Root.render(h('window', { width: 200, height: 100 }, h(Pane, props)));
    await settle();
  };
  return { x11Root, render };
}

test('a box that starts scrolling in the same commit holds its scrollTo too', async () => {
  // laid out already, but never as a scroller, so no extent was measured
  const ref = React.createRef();
  function Pane({ scroll }) {
    useLayoutEffect(() => {
      if (scroll) ref.current.scrollTo(140);
    }, [scroll]);
    return h(
      'box',
      { ref, style: { overflow: scroll ? 'scroll' : 'hidden', height: 100 } },
      ...rows(),
    );
  }
  const { x11Root, render } = await mountToggle(Pane);
  await render({ scroll: false });
  await render({ scroll: true });
  assert.strictEqual(ref.current.scrollY, 140);
  await x11Root.unmount();
});

test('a scrollTo on a box that does not scroll is not held for when it does', async () => {
  // everything scrolling is inert until the style says scroll
  const ref = React.createRef();
  function Pane({ scroll }) {
    useLayoutEffect(() => {
      ref.current.scrollTo(140);
    }, []);
    return h(
      'box',
      { ref, style: { overflow: scroll ? 'scroll' : 'hidden', height: 100 } },
      ...rows(),
    );
  }
  const { x11Root, render } = await mountToggle(Pane);
  await render({ scroll: false });
  await render({ scroll: true });
  assert.strictEqual(ref.current.scrollY, 0);
  await x11Root.unmount();
});

test('a held scrollTo goes with the scrolling when the box stops first', async () => {
  // a box that stops scrolling drops its offset, as in CSS, and one it was
  // still holding for the pass goes too, rather than landing whenever the
  // box next scrolls
  const ref = React.createRef();
  function Pane({ again }) {
    const [scroll, setScroll] = useState(true);
    useLayoutEffect(() => {
      ref.current.scrollTo(140);
      setScroll(false);
    }, []);
    return h(
      'box',
      {
        ref,
        style: { overflow: scroll || again ? 'scroll' : 'hidden', height: 100 },
      },
      ...rows(),
    );
  }
  const { x11Root, render } = await mountToggle(Pane);
  await render({ again: false });
  await render({ again: true });
  assert.strictEqual(ref.current.scrollY, 0);
  await x11Root.unmount();
});

test('a scrollTo on a laid-out pane still moves, reports and arms the blit inside the call', async () => {
  // big enough for the blit's area gate: a 400x400 pane over 20 rows of 40
  const { x11Root, wnd, root, pane, scrolls } = await mount({
    size: { width: 400, height: 400 },
    pane: { flexGrow: 1 },
    cell: () => ({ height: 40, flexShrink: 0 }),
    count: 20,
  });
  wnd.calls.length = 0;
  pane.scrollTo(48);
  assert.strictEqual(pane.scrollY, 48, 'moved at once');
  assert.deepStrictEqual(
    scrolls.map((s) => s.ev),
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
    'reported at once',
  );
  assert.deepStrictEqual(
    pane._pendingBlitFrom,
    { x: 0, y: 0 },
    'armed from the offsets on screen',
  );
  assert.deepStrictEqual(pane._blitLedger, [], 'with its ledger open');
  assert.ok(root._pendingScrolls.has(pane), 'and queued for the frame');
  await tick();
  assert.deepStrictEqual(
    wnd.calls.filter(([name]) => name === 'scrollRegion'),
    [['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -48]],
    'which blits',
  );
  await x11Root.unmount();
});
