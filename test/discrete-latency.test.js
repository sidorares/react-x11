// Issue #141: a discrete input's visual response is *painted*, not scheduled.
//
// A click has exactly one visual answer — a button darkens, a caret lands,
// focus moves — so there is nothing a frame's wait could coalesce it with,
// and waiting costs up to a frame interval plus a fence round trip on top of
// a paint that measures in the hundreds of microseconds. The dispatcher
// therefore paints when the handler unwinds (src/events.js `discrete`), gated
// on the window's fence (src/frames.js).
//
// Motion is the opposite case and must not change: the pointer reports at
// device rate, and the intermediate positions carry nothing the last one
// doesn't.
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { createMockApp, spinWheel } from './helpers/mock-app.js';
import { hooks } from '../src/trace-registry.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Count paint passes: the frame hook fires once per window flush that
 *  actually painted, which is exactly what "a paint pass" means here. */
function countPaints() {
  const passes = [];
  hooks.frame = (info) => passes.push(info);
  return passes;
}

afterEach(() => {
  hooks.frame = null;
});

const PRESSABLE = {
  focusable: true,
  style: {
    width: 80,
    height: 24,
    backgroundColor: '#cccccc',
    ':active': { backgroundColor: '#333333' },
  },
};

test('a press paints its :active flip in the same event-loop turn', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 100 }, h('box', PRESSABLE)));
  await tick();
  const wnd = app.windows[0];
  const passes = countPaints();
  wnd.ctx.ops.length = 0;

  // deliberately no await: the assertion *is* that this needed no turn of
  // the event loop to become drawing
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });

  assert.strictEqual(passes.length, 1, 'painted from the handler');
  assert.ok(
    wnd.ctx.ops.some(
      (op) => op[0] === 'fillRect' && op[op.length - 1] === '#333333',
    ),
    'and what it painted is the pressed background',
  );

  await x11Root.unmount();
});

test('a click that sets React state is still exactly one paint', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  let renders = 0;
  const Host = () => {
    const [on, setOn] = React.useState(false);
    renders++;
    return h(
      'window',
      { width: 200, height: 100 },
      h('box', {
        ...PRESSABLE,
        onMouseDown: () => setOn(true),
        style: {
          ...PRESSABLE.style,
          backgroundColor: on ? '#00ff00' : '#cccccc',
        },
      }),
    );
  };
  x11Root.render(h(Host));
  await tick();
  const wnd = app.windows[0];
  const passes = countPaints();
  const before = renders;

  // The press is answered by two separate things — the dispatcher's :active
  // flip and React's own state update — and the flush point is after the
  // whole dispatch unwinds so that they land in one pass rather than
  // painting a half-updated frame and then painting again.
  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  assert.ok(renders > before, 'React committed inside the handler');
  assert.strictEqual(passes.length, 1, 'one paint, not two');

  await tick();
  assert.strictEqual(passes.length, 1, 'and the scheduled frame is a no-op');

  await x11Root.unmount();
});

test('a click-placed caret reaches the wire with the press', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h('textinput', { value: 'hello', style: { width: 120, height: 24 } }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const passes = countPaints();

  wnd.emit('mousedown', { x: 20, y: 10, keycode: 1 });
  assert.strictEqual(passes.length, 1, 'focus ring and caret painted at once');

  await x11Root.unmount();
});

test('motion still coalesces to one paint per frame', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h('box', {
        style: {
          width: 80,
          height: 24,
          backgroundColor: '#cccccc',
          ':hover': { backgroundColor: '#eeeeee' },
        },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const passes = countPaints();

  wnd.emit('mousemove', { x: 10, y: 10 });
  wnd.emit('mousemove', { x: 12, y: 10 });
  wnd.emit('mousemove', { x: 14, y: 10 });
  assert.strictEqual(passes.length, 0, 'hover work stays on the frame clock');

  await tick();
  assert.strictEqual(passes.length, 1, 'the whole burst is one paint');

  await x11Root.unmount();
});

test('a wheel burst is one paint, and no notch is lost in it', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        ...Array.from({ length: 20 }, (_, i) =>
          h('box', {
            key: i,
            style: { height: 40, flexShrink: 0, backgroundColor: '#eef1f5' },
          }),
        ),
      ),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const box = wnd._reactX11Node.children[0];
  const passes = countPaints();

  // The wheel is the one input that is *not* on the discrete path, because
  // it is the one ntk coalesces: a touchpad reports a scroll dozens of times
  // a frame and nobody can see the difference between those frames. What
  // makes that free is that the coalescing adds up — ntk hands over the sum
  // of the frame's deltas — so the pacing costs a paint, never a distance.
  // (A real connection delivers one summed event; ten arriving separately,
  // as here, is the harder case and lands in the same place.)
  for (let i = 0; i < 10; i++) spinWheel(wnd, 100, 100, { deltaY: 1 });
  assert.strictEqual(passes.length, 0, 'no paint per notch');

  await tick();
  assert.strictEqual(passes.length, 1, 'the whole burst is one paint');
  assert.strictEqual(box.scrollY, 480, 'and all ten notches are in it');

  await x11Root.unmount();
});

test('a window whose fence is outstanding waits for its scheduled frame', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 100 }, h('box', PRESSABLE)));
  await tick();
  const wnd = app.windows[0];
  const passes = countPaints();
  wnd._frameInFlight = true;

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  assert.strictEqual(passes.length, 0, 'not painted from the handler');

  wnd._frameInFlight = false;
  await tick();
  assert.strictEqual(passes.length, 1, 'the scheduled frame still ran it');

  await x11Root.unmount();
});

test('a transition in flight survives being ticked off-cadence', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(
    h(
      'window',
      { width: 200, height: 100 },
      h('box', {
        focusable: true,
        style: {
          width: 80,
          height: 24,
          backgroundColor: '#cccccc',
          transition: { backgroundColor: 120 },
          ':hover': { backgroundColor: '#ffffff' },
          ':active': { backgroundColor: '#333333' },
        },
      }),
    ),
  );
  await tick();
  const wnd = app.windows[0];
  const node = wnd._reactX11Node.children[0];

  // start a hover transition, then press part way through it. The press
  // paints synchronously, which steps the animation clock at a moment the
  // frame clock would never have picked — it is time-based, so that is only
  // a sample, but the transition must still be running and must still land.
  wnd.emit('mousemove', { x: 10, y: 10 });
  await tick();
  assert.ok(
    wnd._reactX11Node._animating.size > 0,
    'the hover transition is in flight',
  );

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  assert.ok(node.states[':active'], 'the press registered');

  const deadline = Date.now() + 2000;
  while (
    wnd._reactX11Node._animating.size > 0 &&
    Date.now() < deadline &&
    !wnd._reactX11Node.destroyed
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    wnd._reactX11Node._scheduled = false;
    wnd._reactX11Node.flush();
  }
  assert.strictEqual(
    wnd._reactX11Node._animating.size,
    0,
    'and it finished rather than sticking part way',
  );
  assert.strictEqual(
    node.style.backgroundColor,
    '#333333',
    'landing on the pressed colour',
  );

  await x11Root.unmount();
});

// --- against the real thing --------------------------------------------
//
// Everything above drives a mock whose `frameInFlight` the test writes
// itself. This one runs the same press through a real ntk window on a real
// (in-process) X server, so what is under test is the contract rather than
// our idea of it: that ntk answers the gate, that a paint from inside the
// handler is presented before the handler returns, and that presenting arms
// the fence — which is the whole reason a burst does not paint ten times.

async function xserverApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const app = await createClient({ stream: clientEnd });
  return { server, app };
}

const roundTrip = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => resolve()));

// A core input event as it arrives on ntk's raw stream: ButtonPress is 4,
// and buttons 4-7 are what a wheel is in the core protocol.
const buttonPress = (keycode) => ({ type: 4, x: 100, y: 100, keycode });
const buttonRelease = (keycode) => ({ type: 5, x: 100, y: 100, keycode });

/** The scene both real-ntk tests use: a scroll pane taller than its window,
 *  with a pressable at the top so a press has something to darken. */
function scrollScene(x11Root, onWindow) {
  x11Root.render(
    h(
      'window',
      { width: 200, height: 200 },
      h('box', PRESSABLE),
      h(
        'box',
        { style: { overflow: 'scroll', flexGrow: 1 } },
        ...Array.from({ length: 20 }, (_, i) =>
          h('box', {
            key: i,
            style: { height: 40, flexShrink: 0, backgroundColor: '#eef1f5' },
          }),
        ),
      ),
    ),
    onWindow,
  );
}

test('real ntk: the press paints, and the present shuts the gate behind it', async (t) => {
  const { server, app } = await xserverApp();
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await app.close?.();
    server.close?.();
  });

  // the render callback hands back the root child's public instance, which
  // for a <window> is the live ntk window
  let wnd = null;
  scrollScene(x11Root, (instance) => {
    wnd = instance;
  });
  await tick();
  await roundTrip(app);
  await tick();
  await roundTrip(app);

  assert.ok(wnd?.id, 'the window exists');
  assert.strictEqual(
    typeof wnd.frameInFlight,
    'function',
    'this ntk publishes the gate (>= 5.2.0)',
  );
  assert.strictEqual(wnd.frameInFlight(), false, 'the server is caught up');

  const passes = countPaints();
  // a press on the pressable, and the release that ends it — two discrete
  // events, each with one visual answer of its own
  wnd.emit('event', { type: 4, x: 10, y: 10, keycode: 1 });

  assert.strictEqual(passes.length, 1, 'the press painted, from its handler');
  assert.strictEqual(
    wnd.frameInFlight(),
    true,
    'presenting it armed the fence, which is what paces what follows',
  );

  // The release's answer rides the paced frame, because the fence the press
  // armed is still outstanding: update instantly, then catch up.
  wnd.emit('event', { type: 5, x: 10, y: 10, keycode: 1 });
  assert.strictEqual(passes.length, 1, 'the fence held the release');

  const deadline = Date.now() + 2000;
  while (passes.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.strictEqual(passes.length, 2, 'one catch-up frame for the rest');

  await x11Root.unmount();
});

test('real ntk: a spun wheel paints twice, not ten times, and loses no notch', async (t) => {
  const { server, app } = await xserverApp();
  const x11Root = await createRoot({ app });
  t.after(async () => {
    await app.close?.();
    server.close?.();
  });

  let wnd = null;
  scrollScene(x11Root, (instance) => {
    wnd = instance;
  });
  await tick();
  await roundTrip(app);
  await tick();
  await roundTrip(app);
  const pane = wnd._reactX11Node.children[1];

  const passes = countPaints();
  // Ten notches of a spun wheel, all inside one round trip. This server has
  // no XI2, so they arrive the way they always did — as presses of button 5,
  // each with its release — and ntk turns them into its own `wheel`.
  for (let i = 0; i < 10; i++) {
    wnd.emit('event', buttonPress(5));
    wnd.emit('event', buttonRelease(5));
  }
  // Still one paint for the first notch and not ten for the burst, though
  // neither number is the wheel's doing any more: the press behind it is a
  // discrete event, and the flush that ends *its* dispatch pays off the
  // scroll the wheel just did. On a connection with XI2 there is no press —
  // the wheel arrives inside ntk's frame, which paints before it ends, so
  // the first notch is on screen just as fast by the other route.
  assert.strictEqual(passes.length, 1, 'the first notch painted, alone');
  assert.strictEqual(
    wnd.frameInFlight(),
    true,
    'presenting it armed the fence, which is what held the other nine',
  );

  const deadline = Date.now() + 2000;
  while (passes.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.strictEqual(passes.length, 2, 'one catch-up frame for the rest');
  assert.strictEqual(pane.scrollY, 480, 'and every notch is in the distance');

  await x11Root.unmount();
});

test('an ntk without the fence accessor keeps the scheduled path', async () => {
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 100 }, h('box', PRESSABLE)));
  await tick();
  const wnd = app.windows[0];
  const passes = countPaints();
  // ntk < 5.2.0: a missing answer is not a "no", so the paced frame stands
  delete wnd.frameInFlight;

  wnd.emit('mousedown', { x: 10, y: 10, keycode: 1 });
  assert.strictEqual(passes.length, 0, 'no gate, no synchronous paint');

  await tick();
  assert.strictEqual(passes.length, 1);

  await x11Root.unmount();
});
