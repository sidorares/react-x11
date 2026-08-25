// The scroll-blit fast path (issue #138): a pure scroll asks ntk to
// CopyArea the surviving band (Window.scrollRegion, sidorares/ntk#139) and
// repaints only the exposed strip plus the scrollbar repair rects. Every
// gate must fall back to the full-viewport repaint scrollTo always claimed.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import { createRoot } from '../src/index.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

// 20 rows of 40px in a 400x400 window: content 800, plenty to scroll, and
// a viewport comfortably above the worth-it area gate.
async function mount({
  windowProps = {},
  scrollProps = {},
  extra = null,
} = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 400, height: 400, ...windowProps },
      h(
        'box',
        { ref, style: { overflow: 'scroll', flexGrow: 1 }, ...scrollProps },
        ...Array.from({ length: 20 }, (_, i) =>
          h('box', {
            key: i,
            style: {
              height: 40,
              flexShrink: 0,
              backgroundColor: i % 2 ? '#ffffff' : '#eef1f5',
            },
          }),
        ),
      ),
      extra,
    ),
  );
  const wnd = app.windows[0];
  return { app, wnd, root: wnd._reactX11Node, ref };
}

const blits = (wnd) => wnd.calls.filter(([name]) => name === 'scrollRegion');

test('a pure scroll blits the viewport and claims only the strip and thumb', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  wnd.calls.length = 0;

  ref.current.scrollTo(48);
  await tick();

  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -48],
  ]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(
    area < 400 * 400 * 0.25,
    `repainted ${area}px² — the strip and thumb rects, not the viewport ` +
      JSON.stringify(rects),
  );
  // the exposed strip is the bottom 48 rows
  const strip = rects.find((r) => r.width === 400);
  assert.ok(strip, `a full-width strip in ${JSON.stringify(rects)}`);
  assert.strictEqual(strip.y + strip.height, 400);
  assert.ok(strip.height >= 48);
});

test('scrolling back up exposes a strip at the top', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  ref.current.scrollTo(96);
  await tick();
  wnd.calls.length = 0;

  ref.current.scrollTo(48);
  await tick();
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, 48],
  ]);
  const strip = root._lastDamageRects.find((r) => r.width === 400);
  assert.strictEqual(strip.y, 0);
  assert.ok(strip.height >= 48);
});

test('several scrollTo calls in one frame blit once, by the net delta', async () => {
  const { wnd, ref } = await mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollBy(48);
  ref.current.scrollBy(48);
  ref.current.scrollBy(-16);
  await tick();
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -80],
  ]);
});

// --- what changed inside the viewport rides along (issue #398) -----------
//
// A claim inside the viewport used to cancel the blit outright. It now goes
// into the frame's ledger and is repainted where the shift leaves it, which
// is what lets a virtualized list — whose own re-slice claims inside the
// viewport on *every* scroll frame — keep the fast path.

const covers = (rects, x, y) =>
  rects.some(
    (r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height,
  );

test('other damage inside the viewport is repainted where the shift leaves it', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  // a second change lands in the same frame, inside the viewport, at the
  // rect it occupies *before* the shift
  root.invalidate(false, { x: 40, y: 120, width: 120, height: 40 });
  await tick();
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -48],
  ]);
  const rects = root._lastDamageRects;
  assert.ok(rects, 'the frame stayed bounded');
  // the blit moved those pixels up by 48, so the repaint has to follow them
  // there rather than stay where the claim was made
  assert.ok(
    covers(rects, 50, 130 - 48),
    `damage misses the moved region: ${JSON.stringify(rects)}`,
  );
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(
    area < 400 * 400 * 0.5,
    `repainted ${area}px² — the strip, the thumb and the moved region`,
  );
});

test('a repaint the damage cap merged back across the viewport is not worth blitting', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  const rows = root.children[0].children;
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  // full-width rows at opposite ends of the viewport: the frame carries
  // four damage rects, so these merge with each other and with the
  // scrollbar column, and the box of that merge is the viewport back again
  root.invalidate(false, rows[1]);
  root.invalidate(false, rows[8]);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'the blit would not pay: no blit');
});

test('a claim that covers the viewport keeps the full repaint', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  const box = root.children[0];
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  // the scroll box's own appearance changed: there is nothing left for the
  // blit to keep, so the ledger declines and the frame poisons as before
  root.invalidate(false, box);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'not a pure scroll: no blit');
});

test('more changes than the ledger carries keep the full repaint', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  const rows = root.children[0].children;
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  for (let i = 0; i < 10; i++) root.invalidate(false, rows[i]);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'past the ledger cap: no blit');
});

test('changes covering most of the viewport keep the full repaint', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  const rows = root.children[0].children;
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  // five 400x40 rows is half the viewport — past that the blit plus the
  // repaints costs more than the one pass it replaced
  for (let i = 0; i < 5; i++) root.invalidate(false, rows[i]);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'not worth the blit: no blit');
});

test('a reflow inside the viewport keeps the full repaint', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  const row = root.children[0].children[2];
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  // a row grows in the same frame: everything below it moves relative to
  // the content, which is not the translation the blit is about to make
  row.applyProps({ style: { height: 90, flexShrink: 0 } }, row.props);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'not a pure scroll: no blit');
});

test('content displaced by a sibling’s reflow keeps the full repaint', async () => {
  // A narrow column inside the viewport, so the reflow's *own* claims stay
  // small: what has to stop the blit here is the displacement of everything
  // below the row that grew, which nothing claims but the layout diff.
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  const rowRef = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 400, height: 400 },
      h(
        'box',
        { ref, style: { overflow: 'scroll', flexGrow: 1 } },
        h(
          'box',
          { style: { width: 100, flexShrink: 0 } },
          ...Array.from({ length: 20 }, (_, i) =>
            h('box', {
              key: i,
              ref: i === 2 ? rowRef : undefined,
              style: {
                height: 40,
                flexShrink: 0,
                backgroundColor: i % 2 ? '#ffffff' : '#eef1f5',
              },
            }),
          ),
        ),
      ),
    ),
  );
  const wnd = app.windows[0];
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  const node = rowRef.current;
  node.applyProps({ style: { height: 48, flexShrink: 0 } }, node.props);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'not a pure scroll: no blit');
  await x11Root.unmount();
});

test('a fractional target keeps the full repaint', async () => {
  const { wnd, ref } = await mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48.5);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('a small viewport is not worth the bookkeeping', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h(
        'box',
        { ref, style: { overflow: 'scroll', flexGrow: 1 } },
        ...Array.from({ length: 10 }, (_, i) =>
          h('box', { key: i, style: { height: 40, flexShrink: 0 } }),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  wnd.calls.length = 0;
  ref.current.scrollTo(40);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('a page-sized jump repaints instead of blitting a sliver', async () => {
  const { wnd, ref } = await mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(240); // 60% of the viewport: less than half survives
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('a border on the scroll box keeps the full repaint', async () => {
  const { wnd, ref } = await mount({
    scrollProps: {
      style: { flexGrow: 1, borderWidth: 2, borderColor: '#333333' },
    },
  });
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
});

test('an overlapping sibling above the viewport keeps the full repaint', async () => {
  const { wnd, ref } = await mount({
    extra: h('box', {
      style: {
        position: 'absolute',
        left: 150,
        top: 150,
        width: 100,
        height: 40,
        backgroundColor: '#ffcc00',
      },
    }),
  });
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 0, 'its pixels must not be dragged');
});

test('an ntk without scrollRegion gets the old behavior untouched', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  delete wnd.scrollRegion;
  wnd.calls.length = 0;
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(blits(wnd).length, 0);
  // the claim stays the viewport — which fills this window, so the frame
  // reports the old full repaint
  assert.strictEqual(root._lastDamage, null);
});

test('a refused blit falls back to the full repaint', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  wnd.scrollRegion = () => false; // e.g. ntk with no valid backing store
  ref.current.scrollTo(48);
  await tick();
  assert.strictEqual(root._lastDamage, null);
});

test('the scrolled thumb is repainted at both its old and new place', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  // start mid-list, so the dragged copy of the old thumb stays on screen
  ref.current.scrollTo(96);
  await tick();
  const sv = root.children[0];
  const before = sv._scrollbar('y');
  wnd.calls.length = 0;
  ref.current.scrollTo(144);
  await tick();
  const after = sv._scrollbar('y');
  assert.notStrictEqual(before.thumbStart, after.thumbStart);
  const rects = root._lastDamageRects;
  const covers = (r, x, y) =>
    x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
  // the new thumb, and the blit-dragged copy of the old one (shifted up)
  for (const point of [
    [after.x + 3, after.y + 3],
    [before.x + 3, before.y + 3 - 48],
  ]) {
    assert.ok(
      rects.some((r) => covers(r, point[0], point[1])),
      `damage misses thumb pixel at ${point}: ${JSON.stringify(rects)}`,
    );
  }
});

// --- the virtualized list, the case the ledger exists for (issue #398) ---
//
// A list that re-slices itself on every scroll frame claims inside its own
// viewport every frame, by design: the spacers resize and the entering rows
// mount. Node-granular poisoning meant the blit fired on the first notch of
// a wheel flick and never again.

const ROW = 40;
const ROWS = 1000;

const LITERAL_ROWS = {
  row: (i) => (i % 2 ? '#ffffff' : '#dbe4ee'),
  marker: (hot) => (hot ? '#c03030' : '#8fa8c8'),
};

function VirtualList({ scrollRef, height, colors = LITERAL_ROWS }) {
  const [top, setTop] = React.useState(0);
  const first = Math.floor(top / ROW);
  const last = Math.min(ROWS, first + Math.ceil(height / ROW) + 2);
  const rows = [];
  for (let i = first; i < last; i++) {
    rows.push(
      h(
        'box',
        {
          key: i,
          style: {
            height: ROW,
            flexShrink: 0,
            padding: 8,
            backgroundColor: colors.row(i),
          },
        },
        // A marker that follows the slice rather than the row: two rows in
        // the middle of the viewport change appearance on every scroll
        // frame, which is the skeleton-to-content upgrade issue #398 names
        // — a claim in the band the blit keeps, not in the strip.
        h('box', {
          style: {
            width: 24,
            height: 24,
            backgroundColor: colors.marker(i === first + 3),
          },
        }),
      ),
    );
  }
  return h(
    'box',
    {
      ref: scrollRef,
      style: { overflow: 'scroll', flexGrow: 1 },
      onScroll: (e) => setTop(e.scrollY),
    },
    h('box', { key: 'above', style: { height: first * ROW, flexShrink: 0 } }),
    ...rows,
    h('box', {
      key: 'below',
      style: { height: (ROWS - last) * ROW, flexShrink: 0 },
    }),
  );
}

test('a virtualized list keeps the fast path through a wheel flick (#398)', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 400, height: 400 },
      h(VirtualList, { scrollRef: ref, height: 400 }),
    ),
  );
  const wnd = app.windows[0];
  const root = wnd._reactX11Node;
  // three frames to settle: mount, first layout, the slice that reports
  for (let i = 0; i < 3; i++) await tick();

  let blitted = 0;
  let worst = 0;
  const notches = 12;
  for (let i = 0; i < notches; i++) {
    wnd.calls.length = 0;
    // the notch lands while the previous notch's re-slice commit is still
    // in flight, which is what makes every frame from the second on a
    // scroll *and* a child-list change in the same frame
    spinWheel(wnd, 100, 100, { deltaY: 1 });
    await tick();
    if (blits(wnd).length) blitted += 1;
    const rects = root._lastDamageRects;
    const area = rects
      ? rects.reduce((sum, r) => sum + r.width * r.height, 0)
      : 400 * 400;
    worst = Math.max(worst, area);
  }
  assert.strictEqual(
    blitted,
    notches,
    `only ${blitted}/${notches} notches blitted — the re-slice is ` +
      'poisoning the frame again',
  );
  assert.ok(
    worst < 400 * 400 * 0.25,
    `worst frame repainted ${worst}px² of 160000 — the strip and the ` +
      'entering rows, not the viewport',
  );
  await x11Root.unmount();
});

test('token-styled rows keep the fast path too (issue #402)', async () => {
  // The same flick with the rows' colours arriving through the palette
  // instead of being written out — which is what docs/styling.md tells an
  // app to do, and what the components stress tree does. Mounting a node
  // whose style mentions a `$token` used to claim full-window damage from
  // the theme walk, so a re-slice degraded every frame from the second on
  // and the ledger never saw an eligible one.
  const THEME = {
    rowA: '#ffffff',
    rowB: '#dbe4ee',
    hot: '#c03030',
    cold: '#8fa8c8',
  };
  const TOKEN_ROWS = {
    row: (i) => (i % 2 ? '$rowA' : '$rowB'),
    marker: (hot) => (hot ? '$hot' : '$cold'),
  };
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  x11Root.render(
    h(
      'window',
      { width: 400, height: 400, theme: THEME },
      h(VirtualList, { scrollRef: ref, height: 400, colors: TOKEN_ROWS }),
    ),
  );
  const wnd = app.windows[0];
  for (let i = 0; i < 3; i++) await tick();

  let blitted = 0;
  const notches = 12;
  for (let i = 0; i < notches; i++) {
    wnd.calls.length = 0;
    spinWheel(wnd, 100, 100, { deltaY: 1 });
    await tick();
    if (blits(wnd).length) blitted += 1;
  }
  assert.strictEqual(
    blitted,
    notches,
    `only ${blitted}/${notches} notches blitted — following the palette ` +
      'must not cost the fast path',
  );
  // and the rows really are the palette's colours, not stripped tokens
  const row = ref.current.children[1];
  assert.ok(
    [THEME.rowA, THEME.rowB].includes(row.style.backgroundColor),
    `row resolved to ${row.style.backgroundColor}`,
  );
  await x11Root.unmount();
});

// --- pixel truth against the real ntk + in-process X server --------------
//
// The whole optimisation stands on one invariant: a blitted scroll frame is
// byte-identical to the full repaint it replaced. Skipped when the
// installed ntk has no scrollRegion yet (the fast path never fires there,
// which the mock tests above already cover).

const require = createRequire(import.meta.url);

async function createHeadlessApp() {
  const server = xserver.createServer({ width: 640, height: 480 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(
    readFileSync(
      join(
        dirname(require.resolve('katex/package.json')),
        'dist',
        'fonts',
        'KaTeX_Main-Regular.ttf',
      ),
    ),
    { family: 'Test Main' },
  );
  fontSource.alias('sans-serif', 'Test Main');
  return await createClient({ stream: clientEnd, fontSource });
}

const settle = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

test('a blitted scroll is byte-identical to the repaint it replaced', async (t) => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 400, height: 300, style: { backgroundColor: '#f5f6fa' } },
          h(
            'box',
            { ref, style: { overflow: 'scroll', flexGrow: 1 } },
            ...Array.from({ length: 40 }, (_, i) =>
              h(
                'box',
                {
                  key: i,
                  style: {
                    height: 40,
                    flexShrink: 0,
                    padding: 6,
                    backgroundColor: i % 2 ? '#ffffff' : '#dbe4ee',
                  },
                },
                h(
                  'text',
                  { style: { fontSize: 12, color: '#20304a' } },
                  `row ${i} — some content`,
                ),
              ),
            ),
          ),
        ),
        resolve,
      ),
    );
    if (typeof instance.scrollRegion !== 'function') {
      t.skip('installed ntk has no Window.scrollRegion yet');
      return;
    }
    const root = instance._reactX11Node;
    const frame = () => {
      root._scheduled = false;
      root.flush();
    };
    frame();
    await settle(app);

    // scroll through the fast path, and prove it really took it
    let blitCalls = 0;
    const realScrollRegion = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return realScrollRegion(...args);
    };
    ref.current.scrollTo(48);
    frame();
    await settle(app);
    assert.strictEqual(blitCalls, 1, 'the fast path fired');
    assert.ok(root._lastDamageRects, 'and the frame stayed bounded');
    const blitted = await readPixels(root._ctx, 400, 300);

    // repaint the same state from scratch: the ground truth
    root.invalidate(false);
    frame();
    await settle(app);
    const repainted = await readPixels(root._ctx, 400, 300);
    assert.ok(
      Buffer.from(blitted.data).equals(Buffer.from(repainted.data)),
      'blitted pixels differ from a full repaint of the same state',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test("a virtualized list's blitted frame is byte-identical to its repaint (#398)", async (t) => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    const instance = await new Promise((resolve) =>
      x11Root.render(
        h(
          'window',
          { width: 400, height: 300, style: { backgroundColor: '#f5f6fa' } },
          h(VirtualList, { scrollRef: ref, height: 300 }),
        ),
        resolve,
      ),
    );
    if (typeof instance.scrollRegion !== 'function') {
      t.skip('installed ntk has no Window.scrollRegion yet');
      return;
    }
    const root = instance._reactX11Node;
    const frame = () => {
      root._scheduled = false;
      root.flush();
    };
    frame();
    await tick();
    frame();
    await settle(app);

    let blitCalls = 0;
    const realScrollRegion = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (...args) => {
      blitCalls += 1;
      return realScrollRegion(...args);
    };

    // Hold the frame open across the re-slice: `_scheduled` reads as "a
    // flush is already booked", so the scroll and the commit its onScroll
    // triggers land in one frame — the interleaving a wheel flick produces,
    // and the one the ledger is for.
    root._scheduled = true;
    ref.current.scrollTo(48);
    // React commits on its own scheduler, a turn or two out; the frame stays
    // booked across all of it, so the commit's claims land in the scroll's
    // own frame rather than the one after
    for (let i = 0; i < 5; i++) await tick();
    frame();
    await settle(app);
    assert.strictEqual(
      blitCalls,
      1,
      'the fast path fired through the re-slice',
    );
    assert.ok(root._lastDamageRects, 'and the frame stayed bounded');
    // the slice really did move: otherwise this is the plain-scroll test
    assert.strictEqual(root.children[0].children[0].abs.height, 40);
    const blitted = await readPixels(root._ctx, 400, 300);

    // repaint the same state from scratch: the ground truth
    root.invalidate(false);
    frame();
    await settle(app);
    const repainted = await readPixels(root._ctx, 400, 300);
    assert.ok(
      Buffer.from(blitted.data).equals(Buffer.from(repainted.data)),
      'blitted pixels differ from a full repaint of the same state',
    );
  } finally {
    await x11Root.unmount();
    await app.close();
  }
});

test('damage claimed before the frame’s first scrollTo rides the blit too (#295)', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  const row = root.children[0].children[2];
  const was = { ...row.abs };
  wnd.calls.length = 0;
  // The race: the claim lands first, while no scroll is pending, so the
  // claim-time gate in WindowNode.invalidate never sees it — and the
  // viewport claim that follows coalesces the rect away (addDamageRect
  // keeps the list disjoint), leaving the pure-scroll gate nothing to see.
  // Arming reads the damage list for exactly that reason, and the rects it
  // finds go into the ledger like any other.
  root.invalidate(false, row);
  ref.current.scrollTo(48);
  await tick();
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -48],
  ]);
  assert.ok(
    covers(root._lastDamageRects, was.x + 2, was.y + 2 - 48),
    `damage misses the moved row: ${JSON.stringify(root._lastDamageRects)}`,
  );
});

test('a claim between two scrolls cannot re-arm the blit mid-frame (#295)', async () => {
  const { wnd, root, ref } = await mount();
  await tick();
  wnd.calls.length = 0;
  ref.current.scrollTo(48); // arms, origin = the frame's true start
  // lands between the two, naming the rect it occupies at the true origin
  root.invalidate(false, { x: 40, y: 200, width: 120, height: 40 });
  ref.current.scrollBy(48); // must not re-arm from the mid-frame origin
  await tick();
  // The whole frame is one shift of 96 from the origin the first scrollTo
  // recorded. A blit of 48 from a mid-frame origin would move a band the
  // first delta had already displaced, and the ledger's rects — claimed
  // at the true origin — would be repainted 48 pixels off.
  assert.deepStrictEqual(blits(wnd), [
    ['scrollRegion', { x: 0, y: 0, width: 400, height: 400 }, 0, -96],
  ]);
  assert.ok(
    covers(root._lastDamageRects, 50, 210 - 96),
    `damage misses the region at the true delta: ` +
      JSON.stringify(root._lastDamageRects),
  );
});
