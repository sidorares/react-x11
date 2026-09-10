// A `scrollTo` on a pane that has been laid out, made from the commit that
// grew its content: the chat and log pattern, where a row is appended and a
// `useLayoutEffect` then scrolls to the end. The new row is mounted but not
// yet measured when the effect runs, since layout happens on the frame
// clock, after the commit.
//
// Production scheduling throughout (createMockApp + createRoot, setImmediate
// ticks, no act), because what is asserted is which frame shows what.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React, { useLayoutEffect, useState } from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';
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
 * A 100px pane over `count` 80px rows in a 200x100 window: 240 of content,
 * so the furthest it scrolls is 140. `grow()` commits one more row, and
 * `follow(pane, rows)` runs from that commit's layout effect, with the new
 * row mounted but not laid out.
 *
 * `frames` is every frame painted after the mount, with the pane's offset
 * and extent as it stood right after it (the tracer's `frame` hook), and
 * `scrolls` every `onScroll`, with how many frames had painted when it
 * arrived.
 */
async function mountLog({
  follow = () => {},
  count = 3,
  size = { width: 200, height: 100 },
  pane = { height: 100 },
  row = () => ({ height: 80, flexShrink: 0 }),
} = {}) {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  const ref = React.createRef();
  const rows = [];
  const frames = [];
  const scrolls = [];
  let setCount;
  function Log() {
    const [n, setN] = useState(count);
    setCount = setN;
    while (rows.length < n) rows.push(React.createRef());
    useLayoutEffect(() => {
      if (n > count) {
        follow(
          ref.current,
          rows.slice(0, n).map((r) => r.current),
        );
      }
    }, [n]);
    return h(
      'box',
      {
        ref,
        style: { overflow: 'scroll', ...pane },
        onScroll: (ev) => scrolls.push({ ev, frames: frames.length }),
      },
      ...Array.from({ length: n }, (_, i) =>
        h('box', { key: i, ref: rows[i], style: row(i) }),
      ),
    );
  }
  x11Root.render(h('window', size, h(Log)));
  await settle();
  const outer = hooks.frame;
  hooks.frame = () => {
    frames.push({
      scrollY: ref.current.scrollY,
      contentHeight: ref.current.contentHeight,
    });
  };
  const wnd = app.windows[0];
  return {
    app,
    wnd,
    root: wnd._reactX11Node,
    pane: ref.current,
    frames,
    scrolls,
    grow: async (rows = 1) => {
      setCount((n) => n + rows);
      await settle();
    },
    done: async () => {
      hooks.frame = outer;
      await x11Root.unmount();
    },
  };
}

test('a scrollTo past the old end, from the commit that added a row, reaches the new end', async () => {
  const log = await mountLog({ follow: (pane) => pane.scrollTo(1000) });
  assert.strictEqual(log.pane.scrollY, 0);
  await log.grow();
  assert.strictEqual(log.pane.contentHeight, 320);
  assert.strictEqual(log.pane.scrollY, 220, '320 of content in a 100px pane');
  assert.deepStrictEqual(
    log.frames.map((f) => f.scrollY),
    [220],
    'in the frame that shows the new row',
  );
  await log.done();
});

test('scrollIntoView on the new row reaches the new end in the same frame', async () => {
  const log = await mountLog({
    follow: (pane, rows) => pane.scrollIntoView(rows.at(-1)),
  });
  await log.grow();
  assert.strictEqual(log.pane.scrollY, 220);
  assert.deepStrictEqual(
    log.frames.map((f) => f.scrollY),
    [220],
  );
  await log.done();
});

test('scrollTo(contentHeight), the chat example’s follow, reaches the new end', async () => {
  // examples/chat.jsx: `node.scrollTo(node.contentHeight)` from a layout
  // effect. `contentHeight` is the last pass's measurement too, so this is
  // the same stale clamp reached through a stale target.
  const log = await mountLog({
    follow: (pane) => pane.scrollTo(pane.contentHeight),
  });
  await log.grow();
  assert.strictEqual(log.pane.scrollY, 220);
  await log.done();
});

test('a scrollBy after a held scrollTo moves on from where the pass puts it', async () => {
  // a follow to the end, then a notch back up before the frame: a reader
  // leaving a log that is still growing lands 48 short of the new end, not
  // of the old one
  const log = await mountLog({
    follow: (pane) => {
      pane.scrollTo(1000);
      pane.scrollBy(-48);
    },
  });
  await log.grow();
  assert.strictEqual(log.pane.scrollY, 172, '220 - 48');
  await log.done();
});

test('notches past the old end go as far as they would on the new extent', async () => {
  // at the old end, two notches down in the commit that brought two rows:
  // 400 of content, so the pane can go the whole 96 past 140
  const log = await mountLog({
    follow: (pane) => {
      pane.scrollBy(48);
      pane.scrollBy(48);
    },
  });
  log.pane.scrollTo(1000);
  await settle();
  assert.strictEqual(log.pane.scrollY, 140, 'at the old end');
  await log.grow(2);
  assert.strictEqual(log.pane.contentHeight, 400);
  assert.strictEqual(log.pane.scrollY, 236, '140 + 2 × 48');
  await log.done();
});

// --- pixel truth: a held answer rides the blit ------------------------------
//
// The pass answers a held request before anything is placed, and the blit
// was armed by the immediate half from the offsets on screen, so a frame that
// stays a blit shifts by the whole move and not by the part the old extent
// allowed. Against the real ntk and the in-process X server, like the
// byte-identical tests in scroll-blit.test.js.

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

const roundTrip = (app) =>
  new Promise((resolve, reject) =>
    app.X.GetInputFocus((err) => (err ? reject(err) : resolve())),
  );

const readPixels = (ctx, w, h) =>
  new Promise((resolve, reject) =>
    ctx.getImageData(0, 0, w, h, (err, data) =>
      err ? reject(err) : resolve(data),
    ),
  );

const textRow = (i) =>
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
    h('text', { style: { fontSize: 12, color: '#20304a' } }, `row ${i}`),
  );

test('a held answer in a frame that blits shifts by the whole move, byte-identical to a repaint', async (t) => {
  const app = await createHeadlessApp();
  const x11Root = await createRoot({ app });
  try {
    const ref = React.createRef();
    function Log({ extra }) {
      useLayoutEffect(() => {
        // a notch past the old end, from the commit that grew the content
        if (extra > 0) ref.current.scrollBy(48);
      }, [extra]);
      return h(
        'box',
        { ref, style: { overflow: 'scroll', flexGrow: 1 } },
        ...Array.from({ length: 20 }, (_, i) => textRow(i)),
        // a row arriving below the fold: the footer's claim lies outside the
        // viewport, so the frame stays a blit candidate — and a short one,
        // since the ledger sums the entering row's claims, which overlap
        h(
          'box',
          { key: 'footer', style: { flexShrink: 0 } },
          ...Array.from({ length: extra }, (_, i) =>
            h('box', {
              key: i,
              style: { height: 20, flexShrink: 0, backgroundColor: '#ffd966' },
            }),
          ),
        ),
      );
    }
    const tree = (extra) =>
      h(
        'window',
        { width: 400, height: 300, style: { backgroundColor: '#f5f6fa' } },
        h(Log, { extra }),
      );
    const instance = await new Promise((resolve) =>
      x11Root.render(tree(0), resolve),
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
    await roundTrip(app);
    const pane = ref.current;
    // 20 short of the old end: 800 of content in a 300px pane
    pane.scrollTo(480);
    frame();
    await roundTrip(app);
    assert.strictEqual(pane.scrollY, 480);

    const shifts = [];
    const realScrollRegion = instance.scrollRegion.bind(instance);
    instance.scrollRegion = (rect, dx, dy) => {
      shifts.push([dx, dy]);
      return realScrollRegion(rect, dx, dy);
    };
    await new Promise((resolve) => x11Root.render(tree(1), resolve));
    assert.strictEqual(pane.scrollY, 500, 'the old extent answers 20 at once');
    frame();
    await roundTrip(app);
    assert.strictEqual(pane.contentHeight, 820);
    assert.strictEqual(
      pane.scrollY,
      520,
      'and the pass the rest: 528, clamped to the new end',
    );
    assert.deepStrictEqual(
      shifts,
      [[0, -40]],
      'one blit, by the whole move from the offsets on screen',
    );
    assert.ok(root._lastDamageRects, 'the frame stayed bounded');
    const blitted = await readPixels(root._ctx, 400, 300);

    root.invalidate(false);
    frame();
    await roundTrip(app);
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
