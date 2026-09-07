// Frame pacing on a window (src/pacing.js under nodes.js): where a
// window's frame is scheduled, what it costs, and what that decides. The
// mock app, a fake clock on the pacer, and a paint whose cost the test
// sets — so a "flood" is a loop and a "wait" is a timer the test can see,
// with no display and no sleeping. The default is pinned first, because
// it is the promise every existing app rests on: nothing waits.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { flushPendingFrames } from '../src/frames.js';
import { hooks } from '../src/trace-registry.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The pacer's clock, moved by hand; `after` fires when `advance` reaches it. */
function fakeClock() {
  let t = 1000;
  const timers = [];
  return {
    now: () => t,
    after(ms, fn) {
      const entry = { at: t + ms, ms, fn, live: true };
      timers.push(entry);
      return () => {
        entry.live = false;
      };
    },
    armed: () => timers.filter((e) => e.live),
    advance(ms) {
      t += ms;
      for (const e of timers.filter((e) => e.live && e.at <= t)) {
        e.live = false;
        e.fn();
      }
    },
  };
}

const roots = [];
afterEach(async () => {
  delete process.env.REACT_X11_FRAME_RATE;
  hooks.frame = null;
  for (const root of roots.splice(0)) await root.unmount();
});

/**
 * A window with one box, the pacer on a fake clock, and a frame that
 * costs `cost` ms of that clock. `claim()` is what a streaming element
 * does: a bounded invalidate of the box. `frame()` claims once and lets
 * the frame run through the real scheduling — the wait if the pacer asks
 * for one, then the window's callback — and answers what it waited.
 */
async function mount({ cost = 6, rootOptions = {}, ...props } = {}) {
  const app = createMockApp();
  const root = await createRoot({ app, ...rootOptions });
  roots.push(root);
  const tree = (extra = {}) =>
    h(
      'window',
      { width: 200, height: 120, ...props, ...extra },
      h('box', { style: { width: 100, height: 50, backgroundColor: '#eee' } }),
    );
  root.render(tree());
  await tick();
  const node = app.windows[0]._reactX11Node;
  const clock = fakeClock();
  node._pacer.clock = clock;
  const box = node.children[0];
  let painted = 0;
  const flushFrame = node._flushFrame.bind(node);
  node._flushFrame = (...args) => {
    const out = flushFrame(...args);
    if (out) {
      painted += 1;
      clock.advance(cost);
    }
    return out;
  };
  const ctx = {
    app,
    root,
    node,
    box,
    clock,
    claim: () => box.invalidate(false, box.contentBox(), 'content'),
    frames: () => painted,
    setCost: (ms) => {
      cost = ms;
    },
    async frame() {
      ctx.claim();
      let waited = 0;
      if (!node._scheduled) {
        const [w] = clock.armed();
        assert.ok(w, 'held on a wait');
        waited = w.ms;
        clock.advance(w.ms);
        assert.equal(node._scheduled, true, 'the wait put it on the clock');
      }
      await tick();
      return waited;
    },
    rerender: async (extra) => {
      root.render(tree(extra));
      await tick();
    },
  };
  return ctx;
}

// --- the default -----------------------------------------------------------------

test("the default is 'display': every claim schedules its frame at once, whatever the last one cost", async () => {
  const { node, clock, claim, frames } = await mount({ cost: 60 });
  assert.equal(node._framePolicy.mode, 'display');
  assert.equal(node._pacer.active, false);
  for (let i = 0; i < 10; i += 1) {
    claim();
    assert.equal(node._scheduled, true, 'the frame is on the clock');
    assert.equal(clock.armed().length, 0, 'and nothing waits');
    await tick();
    assert.equal(frames(), i + 1);
  }
  assert.equal(node._pacer.stats.deferred, 0);
  assert.equal(node._pacer.stats.frames, 11, 'the mount frame, then ten');
  assert.equal(node._pacer.stats.lastCostMs, 60);
});

// --- the sources -------------------------------------------------------------------

test('the prop, the root option and the environment each set the policy, in that order of precedence', async () => {
  const a = await mount({ frameRate: 'adaptive' });
  assert.equal(a.node._framePolicy.mode, 'adaptive');
  assert.equal(a.node._pacer.stats.budget, 0.25);

  const b = await mount({ rootOptions: { frameRate: 'throughput' } });
  assert.equal(b.node._framePolicy.mode, 'throughput', 'the root default');
  const c = await mount({
    frameRate: 30,
    rootOptions: { frameRate: 'throughput' },
  });
  assert.equal(c.node._framePolicy.mode, 'custom', 'the prop wins');
  assert.equal(c.node._framePolicy.maxFps, 30);

  process.env.REACT_X11_FRAME_RATE = 'display';
  const d = await mount({
    frameRate: 'adaptive',
    rootOptions: { frameRate: 'throughput' },
  });
  assert.equal(d.node._framePolicy.mode, 'display', 'the environment wins');
});

test('a prop change re-resolves the policy; the same value again does not reset it', async () => {
  const ctx = await mount({ frameRate: 'adaptive', cost: 6 });
  const { node, rerender } = ctx;
  for (let i = 0; i < 30; i += 1) await ctx.frame();
  assert.ok(node._pacer.wait() > 0, 'in debt');
  await rerender({ frameRate: 'adaptive' });
  assert.ok(node._pacer.wait() > 0, 'the same policy keeps the debt');
  await rerender({ frameRate: 'display' });
  assert.equal(node._framePolicy.mode, 'display');
  assert.equal(node._pacer.wait(), 0, 'and the new one starts afresh');
});

test('a bad value throws at the window, naming the value and the choices', async () => {
  const app = createMockApp();
  const errors = [];
  const root = await createRoot({
    app,
    onUncaughtError: (err) => errors.push(err),
  });
  roots.push(root);
  root.render(h('window', { width: 100, height: 80, frameRate: 'fast' }));
  await tick();
  assert.equal(errors.length, 1);
  assert.match(
    errors[0].message,
    /<window frameRate> "fast" is not a frame rate/,
  );
  assert.match(errors[0].message, /'display'.*'adaptive'.*'throughput'/);
});

test('a bad root default fails at createRoot', async () => {
  const app = createMockApp();
  await assert.rejects(
    createRoot({ app, frameRate: { budget: 2 } }),
    /createRoot\({ frameRate }\)\.budget 2/,
  );
});

// --- the rule, on a window ---------------------------------------------------------

test("under 'adaptive' a flood of expensive frames is held to the budget, and the claims fold into the wait", async () => {
  const ctx = await mount({ frameRate: 'adaptive', cost: 6 });
  const { node, clock, claim, frames } = ctx;
  // the burst goes first: the early frames are not held
  assert.equal(await ctx.frame(), 0);
  assert.equal(frames(), 1);
  // a flood: a claim the moment each frame ends, forty times
  const waits = [];
  for (let i = 0; i < 40; i += 1) {
    claim();
    if (node._scheduled) {
      waits.push(0);
      await tick();
      continue;
    }
    // held: no callback on the clock, one wait armed, further claims fold
    const [wait] = clock.armed();
    assert.ok(wait, 'a wait is armed');
    claim();
    claim();
    assert.equal(clock.armed().length, 1, 'one wait for the three claims');
    waits.push(wait.ms);
    clock.advance(wait.ms);
    assert.equal(node._scheduled, true, 'the wait put the frame on the clock');
    await tick();
  }
  assert.equal(frames(), 41);
  // the burst (50ms of paint at a quarter) covers the first ten or so
  const held = waits.filter((w) => w > 0);
  assert.ok(held.length >= 25, `${held.length} of 40 frames waited`);
  // the first held frame pays whatever the burst left; from then on each
  // waits three times what it cost
  for (const w of held.slice(1)) assert.ok(Math.abs(w - 18) < 1e-6, `${w}`);
  const s = node._pacer.stats;
  assert.equal(s.deferred, held.length);
  assert.equal(s.coalesced, held.length * 2);
  assert.ok(Math.abs(s.lastWaitMs - 18) < 1e-6);
  assert.equal(s.lastCostMs, 6);
});

test('cheap frames never wait, and one relayout among them is free', async () => {
  const ctx = await mount({ frameRate: 'adaptive', cost: 0.4 });
  const { node, clock, frames } = ctx;
  // a scroll's worth of cheap frames, one per 120Hz tick
  for (let i = 0; i < 200; i += 1) {
    assert.equal(await ctx.frame(), 0, `frame ${i}`);
    clock.advance(1000 / 120 - 0.4);
  }
  assert.equal(frames(), 200);
  assert.equal(node._pacer.stats.deferred, 0);
  // the one relayout in it
  ctx.setCost(30);
  assert.equal(await ctx.frame(), 0);
  ctx.setCost(0.4);
  assert.equal(await ctx.frame(), 0, 'the frame after a 30ms one is not held');
  assert.equal(node._pacer.stats.deferred, 0);
});

test('a discrete input paints a held frame at once, and the wait stands down', async () => {
  const ctx = await mount({ frameRate: 'adaptive', cost: 6 });
  const { node, clock, claim, frames } = ctx;
  for (let i = 0; i < 30; i += 1) await ctx.frame();
  const before = frames();
  claim();
  assert.equal(node._scheduled, false, 'held');
  const [wait] = clock.armed();
  assert.ok(wait);
  // the early flush a click or a key gets (frames.js): the debt is paid now
  flushPendingFrames();
  assert.equal(frames(), before + 1, 'painted on the input');
  assert.equal(wait.live, false, 'the wait was cancelled');
  assert.equal(node._pacer.deferring, false);
  assert.equal(node._pacer.stats.lastWaitMs, 0, 'that frame was not held');
  // …and the window is not stuck: the next claim is held or scheduled
  claim();
  assert.ok(node._scheduled || clock.armed().length === 1);
  clock.advance(100);
  await tick();
  assert.equal(frames(), before + 2);
});

test('a claim the frame raises on itself is priced by that frame', async () => {
  const ctx = await mount({ frameRate: 'adaptive', cost: 0.5 });
  const { node, clock, box } = ctx;
  // spend the burst with expensive frames, then rest exactly until the
  // next is owed nothing — the bucket at zero, not refilled…
  ctx.setCost(6);
  for (let i = 0; i < 20; i += 1) await ctx.frame();
  clock.advance(node._pacer.wait());
  assert.equal(node._pacer.wait(), 0);
  // …then a frame that claims again from inside itself — what an animation
  // step or a container query does — and costs 6ms
  const flushFrame = node._flushFrame;
  node._flushFrame = (...a) => {
    box.invalidate(false, box.contentBox(), 'content');
    return flushFrame(...a);
  };
  ctx.claim();
  assert.equal(node._scheduled, true);
  await tick();
  node._flushFrame = flushFrame;
  // the inner claim was answered after the frame, against those 6ms: the
  // burst is spent, so it is held
  assert.equal(node._scheduled, false, 'not on the clock yet');
  assert.equal(clock.armed().length, 1, 'held on the wait');
});

test('unmounting cancels a held frame', async () => {
  const ctx = await mount({ frameRate: 'adaptive', cost: 6 });
  const { node, clock, claim, root } = ctx;
  for (let i = 0; i < 30; i += 1) await ctx.frame();
  claim();
  const [wait] = clock.armed();
  assert.ok(wait?.live, 'held');
  await root.unmount();
  roots.length = 0;
  assert.equal(wait.live, false);
  assert.equal(node.destroyed, true);
});

test('the frame trace names the wait a frame followed', async () => {
  const seen = [];
  hooks.frame = (info) => seen.push(info.waited);
  const ctx = await mount({ frameRate: 'adaptive', cost: 6 });
  for (let i = 0; i < 40; i += 1) await ctx.frame();
  assert.ok(
    seen.some((w) => w === 0),
    'the burst frames waited on nothing',
  );
  assert.ok(
    seen.some((w) => Math.abs(w - 18) < 1e-6),
    `the paced ones waited 18ms: ${seen.slice(-3)}`,
  );
});
