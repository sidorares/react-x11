// The cocoa backend in threaded mode (docs/macos.md §"JS on a worker"), over
// a fake bridge in the shapes windowkit/appkit#50–#54 give a worker: events
// through `connect` in batches the test delivers, a window that is a handle
// at the call and gets its number when AppKit makes it, a flip that is a
// recorded frame, and reads that answer through a callback. What is pinned:
//
//   - a window is keyed by its handle, and events naming the handle reach it;
//   - a batch's inputs are one frame, not one each;
//   - a flip is a frame committed at the size it was painted at, which is
//     what the resize handshake waits for, and the handshake is set at the
//     budget `cocoa.resizeWait` gives;
//   - the next frame waits for the buffer the last flip took off glass, and
//     gives up waiting rather than freeze;
//   - a live resize is AppKit's begin to its end, and a launch policy the
//     app did not get is said;
//   - the clipboard, snapshots, bezels and a drop's payload take their
//     answers the way a worker gets them;
//   - the bootstrap: an exception leaves the delivery, `process.exit` asks
//     the main thread, a signal reaches the worker's `process`, and stdout
//     reaches its fd whole.
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import React from 'react';

import { BezelStore } from '../src/cocoa/bezels.js';
import { readPayload } from '../src/cocoa/dnd.js';
import {
  fdStream,
  forwardSignals,
  openThreadedChannel,
  resetThreadedChannelForTests,
  routeExit,
} from '../src/cocoa/threaded.js';
import { createRoot } from '../src/index.js';
import { fakeCocoaApp, fakeCocoaBridge } from './helpers/cocoa-bridge.js';

process.env.NO_AT_BRIDGE ??= '1';

const h = React.createElement;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(pred, what, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1);
  }
}

// --- the fake bridge, in a worker's shapes -------------------------------------

/**
 * `fakeCocoaBridge` answering as the bridge answers a worker: `deliver`
 * hands the app a batch, `made(handle)` is AppKit making a window the app
 * asked for (its number and published frame exist from then on), and the
 * reads that ask AppKit answer through their callback — and refuse without
 * one, as the bridge does off the main thread.
 */
function threadedBridge() {
  const native = fakeCocoaBridge();
  let onEvents = null;
  let seq = 1000;
  native.pasteboard = null;
  native.connect = (fn) => {
    onEvents = fn;
  };
  native.deliver = (...batch) => onEvents(batch);
  native.createWindow2 = (options) => {
    const id = ++seq;
    return {
      id,
      made: false,
      options: { ...options },
      root: { layer: `root${id}`, props: {}, sublayers: [], parent: null },
    };
  };
  native.windowNumber = (handle) => (handle.made ? handle.id : null);
  native.getWindowFrame = (handle) =>
    handle.made
      ? {
          x: handle.options.x ?? 0,
          y: handle.options.y ?? 0,
          width: handle.options.width,
          height: handle.options.height,
        }
      : null;
  native.made = (handle) => {
    handle.made = true;
    native.deliver({
      type: 'window-created',
      handle,
      windowNumber: handle.id,
    });
  };
  native.setWindowFrame = () => {};
  const answers = (name, answer) => {
    native[name] = (...args) => {
      const cb = args.at(-1);
      if (typeof cb !== 'function') {
        throw new TypeError(
          `${name}: off the main thread it answers through a callback`,
        );
      }
      setImmediate(() => cb(answer(...args)));
    };
  };
  answers('pasteboardReadText', () => native.pasteboard);
  answers('snapshotWindow', () => true);
  return native;
}

const roots = [];
const apps = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
  for (const app of apps.splice(0)) await app.close();
  resetThreadedChannelForTests();
});

/** A CocoaApp started in threaded mode over the fake; `launched` is the
 * activation policy the bridge publishes for the launch. */
function threadedApp(cocoa = {}, { launched = 'regular' } = {}) {
  const native = threadedBridge();
  native.activationPolicy = () => launched;
  // the channel first, as the launcher's bootstrap opens it before the app
  resetThreadedChannelForTests();
  const channel = openThreadedChannel(native);
  const { app } = fakeCocoaApp(cocoa, { native });
  app.start({ channel });
  apps.push(app);
  return { native, app };
}

async function mountThreaded(
  children,
  { cocoa, width = 200, height = 120 } = {},
) {
  const { native, app } = threadedApp(cocoa);
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width, height }, children));
  // the first frame runs on the clock's own timer: there is no pump
  await sleep(20);
  const wnd = [...app._windows.values()][0];
  return { native, app, root, wnd };
}

/** A press and release on `node`, as the bridge reports them on a worker. */
function clickEvents(wnd, node) {
  const s = wnd.scale;
  const x = (node.abs.x + node.abs.width / 2) / s;
  const y = (node.abs.y + node.abs.height / 2) / s;
  const ev = (type) => ({
    type,
    handle: wnd._h,
    x,
    y,
    gx: x,
    gy: y,
    button: 1,
    time: performance.now(),
  });
  return [ev('mousemove'), ev('mousedown'), ev('mouseup')];
}

/** A counter a press increments, shown as text — every press repaints.
 * `shown` is the count it last rendered. */
let shown = 0;
function Counter({ onNode }) {
  const [n, setN] = React.useState(0);
  shown = n;
  return h(
    'box',
    {
      ref: onNode,
      style: { width: 80, height: 30 },
      onMouseDown: () => setN((v) => v + 1),
    },
    h('text', null, `pressed ${n}`),
  );
}

/** Release whatever the last flip is holding, so the next frame can go. */
function releaseHeld(native, wnd) {
  if (wnd._awaiting != null) {
    native.deliver({ type: 'surface-released', id: wnd._awaiting });
  }
}

const flips = (native) => native.of('setLayerContentsIOSurface').length;

// --- windows -----------------------------------------------------------------

test('a worker’s window is keyed by its handle, and learns its number when AppKit makes it', async () => {
  const { native, app, wnd } = await mountThreaded(h('box'));
  assert.strictEqual(wnd.windowNumber, null);
  assert.ok(app._windows.get(wnd._h) === wnd, 'keyed by the handle');

  native.made(wnd._h);
  assert.strictEqual(wnd.windowNumber, wnd._h.id);
  assert.ok(app._windows.get(wnd._h) === wnd, 'still keyed by the handle');

  // and an event that names the handle — the only thing it names — lands
  native.deliver({ type: 'window-focus', handle: wnd._h, time: 0 });
  assert.ok(app._lastKeyWindow === wnd);
});

// --- input -------------------------------------------------------------------

test('a batch of input is one frame: three presses that crossed together paint once', async () => {
  let target = null;
  const { native, wnd } = await mountThreaded(
    h(Counter, { onNode: (n) => (target = n) }),
  );
  releaseHeld(native, wnd);
  // the clock is not due, so what paints now is the batch's own answer and
  // not a frame tick
  wnd._frameInterval = 1000;
  wnd._rafLast = performance.now();
  const before = flips(native);
  const from = native.calls.length;
  native.deliver(
    ...clickEvents(wnd, target),
    ...clickEvents(wnd, target),
    ...clickEvents(wnd, target),
  );
  assert.strictEqual(shown, 3);
  assert.strictEqual(flips(native) - before, 1, 'one present for the batch');
  // Each press commits on its own, and asks for the early flush a discrete
  // event gets (src/frames.js); mid-batch that waits for the batch's end,
  // so the batch is one paint and one present, of all three.
  const laidOut = native.calls
    .slice(from)
    .filter((c) => c.name === 'createLayout')
    .map((c) => c.args[0].spans.map((span) => span.text).join(''))
    .filter((text) => text.startsWith('pressed'));
  assert.deepStrictEqual([...new Set(laidOut)], ['pressed 3']);
});

// --- frames ------------------------------------------------------------------

test('a worker’s flip is a frame committed at the size it was painted at', async () => {
  let target = null;
  const { native, wnd } = await mountThreaded(
    h(Counter, { onNode: (n) => (target = n) }),
    { width: 200, height: 120 },
  );
  releaseHeld(native, wnd);
  native.deliver(...clickEvents(wnd, target));
  const at = native.calls.findLastIndex(
    (c) => c.name === 'setLayerContentsIOSurface',
  );
  assert.ok(at > 0, 'the press was presented');
  assert.deepStrictEqual(native.calls[at - 1], {
    name: 'txBegin',
    args: [{ disableActions: true }],
  });
  // points: the logical size, at scale 2 half the device pixels
  assert.deepStrictEqual(native.calls[at + 1], {
    name: 'txCommit',
    args: [{ width: 200, height: 120 }],
  });

  // AppKit's own figures, once it has reported a size: the handshake
  // compares them exactly
  releaseHeld(native, wnd);
  native.deliver({
    type: 'window-resize',
    handle: wnd._h,
    width: 150,
    height: 90,
    x: 0,
    y: 0,
    live: true,
  });
  assert.deepStrictEqual(native.of('txCommit').at(-1), [
    { width: 150, height: 90 },
  ]);
  assert.deepStrictEqual([wnd.width, wnd.height], [300, 180]);
});

test('the next frame waits for the buffer the last flip took off glass', async () => {
  let target = null;
  const { native, app, wnd } = await mountThreaded(
    h(Counter, { onNode: (n) => (target = n) }),
  );
  // two presents alternate the pair, so the second is taking the first's
  // buffer off glass
  releaseHeld(native, wnd);
  native.deliver(...clickEvents(wnd, target));
  releaseHeld(native, wnd);
  native.deliver(...clickEvents(wnd, target));
  assert.ok(wnd.frameInFlight(), 'the flip is holding the back buffer');
  const held = wnd._awaiting;
  const copies = native.of('copySurfaceRegion').length;
  const presented = flips(native);

  // a press now changes the model, and waits for the buffer to paint it
  native.deliver(...clickEvents(wnd, target));
  assert.strictEqual(flips(native), presented, 'nothing drawn into glass');
  assert.strictEqual(native.of('copySurfaceRegion').length, copies);
  assert.ok(
    app._rafQueue.some((e) => e.wnd === wnd),
    'its frame is parked',
  );

  // the release: the catch-up copy, then the parked frame, in that batch
  native.deliver({ type: 'surface-released', id: held });
  assert.strictEqual(native.of('copySurfaceRegion').length, copies + 1);
  assert.strictEqual(flips(native), presented + 1);
});

test('a flip whose release never comes holds the window for a moment, not for ever', async () => {
  let target = null;
  const { native, wnd } = await mountThreaded(
    h(Counter, { onNode: (n) => (target = n) }),
  );
  releaseHeld(native, wnd);
  native.deliver(...clickEvents(wnd, target));
  releaseHeld(native, wnd);
  native.deliver(...clickEvents(wnd, target));
  assert.ok(wnd.frameInFlight());
  await until(() => !wnd.frameInFlight(), 'the fence to give up', 1000);
});

test('the resize handshake is asked for at the budget cocoa.resizeWait gives', async () => {
  const handshakes = async (cocoa) => {
    const { native } = await mountThreaded(h('box'), { cocoa });
    return native.of('setResizeHandshake').map(([, opts]) => opts);
  };
  assert.deepStrictEqual(await handshakes(undefined), [{ waitMs: 50 }]);
  assert.deepStrictEqual(await handshakes({ resizeWait: 20 }), [
    { waitMs: 20 },
  ]);
  assert.deepStrictEqual(await handshakes({ resizeWait: 0 }), []);
  assert.throws(() => threadedApp({ resizeWait: -1 }), TypeError);

  // the pump's windows are resized in the call that paints them
  const { native, app } = fakeCocoaApp();
  apps.push(app);
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width: 100, height: 80 }));
  await sleep(5);
  assert.deepStrictEqual(native.of('setResizeHandshake'), []);
});

test('a live resize is what AppKit brackets: begin to end, however long the drag pauses', async () => {
  const { native, wnd } = await mountThreaded(h('box'));
  const live = (phase) =>
    native.deliver({ type: 'window-live-resize', handle: wnd._h, phase });
  const tick = (width) =>
    native.deliver({
      type: 'window-resize',
      handle: wnd._h,
      width,
      height: 70,
      x: 0,
      y: 0,
      live: true,
    });
  live('begin');
  tick(110);
  assert.strictEqual(wnd.liveResizing, true);
  await sleep(150);
  assert.strictEqual(wnd.liveResizing, true, 'a pause is not the end');
  tick(120);
  live('end');
  assert.strictEqual(wnd.liveResizing, false);
});

test('under the launcher, a policy the app did not launch with is said, with the variable that sets it', () => {
  const warnings = [];
  const warn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    threadedApp({ activationPolicy: 'accessory' }, { launched: 'regular' });
    assert.match(warnings.join('\n'), /APPKIT_ACTIVATION_POLICY=accessory/);
    warnings.length = 0;
    threadedApp({ activationPolicy: 'accessory' }, { launched: 'accessory' });
    threadedApp({}, { launched: 'regular' });
    assert.deepStrictEqual(warnings, []);
  } finally {
    console.warn = warn;
  }
});

// --- answers that come later ---------------------------------------------------

test('the clipboard is read through the bridge’s callback on a worker', async () => {
  const { native, app } = threadedApp();
  native.pasteboard = 'from AppKit';
  assert.strictEqual(await app.clipboard.read(), 'from AppKit');
  assert.deepStrictEqual(await app.clipboard.targets(), [
    'UTF8_STRING',
    'STRING',
  ]);
  native.pasteboard = null;
  await assert.rejects(app.clipboard.read(), /the pasteboard is empty/);
  assert.deepStrictEqual(await app.clipboard.targets(), []);
});

test('a snapshot is a promise on either thread', async () => {
  const { wnd } = await mountThreaded(h('box'));
  assert.strictEqual(await wnd.snapshot('/tmp/x.png'), true);

  const { native, app } = fakeCocoaApp();
  apps.push(app);
  native.snapshotWindow = () => true;
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width: 100, height: 80 }));
  await sleep(5);
  const pumped = [...app._windows.values()][0];
  const shot = pumped.snapshot('/tmp/y.png');
  assert.ok(shot instanceof Promise);
  assert.strictEqual(await shot, true);
});

/** The two bezel verbs answering the way a worker gets them. */
function answeringBezels() {
  let n = 0;
  const draws = [];
  return {
    draws,
    measureControl: (params, cb) =>
      setImmediate(() => cb({ width: 20, height: 20 })),
    drawControlIntoSurface: (surface, params, cb) => {
      draws.push(params);
      setImmediate(cb);
    },
    createSurface: (w, hh, scale) => ({ id: ++n, w, h: hh, scale }),
    ctxGetImageData: (s, x, y, w, hh) => new Uint8Array(w * hh * 4).fill(255),
  };
}

test('a worker’s bezels: metrics prefetched, a bezel null until drawn, and its pressed twin drawn with it', async () => {
  const native = answeringBezels();
  const store = new BezelStore(native, { answersLater: () => true });
  assert.strictEqual(store.natural('push'), null, 'nothing asked yet');
  await store.prefetch(2);
  // the fake inks the whole scan frame: the measured 20pt, widened by 24
  assert.deepStrictEqual(store.natural('checkbox'), { width: 44, height: 20 });
  assert.deepStrictEqual(store.shadow('radio', 'small'), {
    top: 0,
    bottom: 0,
  });

  const params = { kind: 'push', state: 0, enabled: true };
  let ready = 0;
  assert.strictEqual(
    store.get(params, 40, 20, 2, () => ready++),
    null,
  );
  // asked again before it lands: one draw, both callers told
  assert.strictEqual(
    store.get(params, 40, 20, 2, () => ready++),
    null,
  );
  await until(() => ready === 2, 'the bezel');
  const bezel = store.get(params, 40, 20, 2);
  assert.ok(bezel?.surface, 'drawn, and cached');
  assert.strictEqual(
    native.draws.filter((p) => p.kind === 'push' && !p.pressed && p.state === 0)
      .length,
    1,
  );
  // the twin is drawn without being asked for — asking would draw it
  await until(
    () => native.draws.some((p) => p.kind === 'push' && p.pressed === true),
    'the pressed twin',
  );
  await sleep(5);
  assert.ok(store.get({ ...params, pressed: true }, 40, 20, 2), 'cached');

  // an accent change while a draw is out: the callers hear, the cache not
  let late = 0;
  store.get({ kind: 'switch', state: 1 }, 30, 20, 2, () => late++);
  store.clear();
  await until(() => late === 1, 'the draw that crossed the change');
  assert.strictEqual(
    store.get({ kind: 'switch', state: 1 }, 30, 20, 2),
    null,
    'drawn again, in the new accent',
  );
});

test('a worker’s drop reads the payload its event carried', () => {
  const native = {};
  const payload = readPayload(
    native,
    ['text/plain', 'text/uri-list', 'image/png'],
    [
      {
        types: ['public.utf8-plain-text', 'public.png'],
        strings: { 'public.utf8-plain-text': 'dropped' },
      },
      {
        types: ['public.file-url'],
        strings: { 'public.file-url': 'file:///tmp/a.txt' },
      },
    ],
  );
  assert.strictEqual(payload.text, 'dropped');
  assert.deepStrictEqual(
    payload.files.map((f) => f.path),
    ['/tmp/a.txt'],
  );
  assert.strictEqual(payload.items['image/png'], undefined);
});

// --- the bootstrap -------------------------------------------------------------

test('what a subscriber throws leaves the delivery, once every subscriber has the batch', () => {
  resetThreadedChannelForTests();
  let deliver = null;
  const channel = openThreadedChannel({ connect: (fn) => (deliver = fn) });
  const seen = [];
  channel.subscribe(() => {
    throw new Error('from a handler');
  });
  channel.subscribe((batch) => seen.push(...batch));
  // out of the delivery, where the bridge makes it the worker's uncaught
  // exception (windowkit/appkit#65)
  assert.throws(() => deliver([{ type: 'keydown' }]), /from a handler/);
  assert.deepStrictEqual(seen, [{ type: 'keydown' }]);
});

test('process.exit on the worker asks the main thread first, with its code', () => {
  const asked = [];
  const exited = [];
  const proc = { exitCode: undefined, exit: (code) => exited.push(code) };
  routeExit({ requestExit: (code) => asked.push(code) }, proc);
  proc.exit(3);
  proc.exitCode = 7;
  proc.exit();
  proc.exit('2');
  assert.deepStrictEqual(asked, [3, 7, 2]);
  assert.deepStrictEqual(exited, [3, undefined, '2']);
});

test('a signal reaches the worker’s process — or ends it, as the signal would', () => {
  const proc = new EventEmitter();
  const exits = [];
  proc.exit = (code) => exits.push(code);
  const handle = forwardSignals(proc);
  handle([{ type: 'mousemove' }, { type: 'signal', signal: 'SIGINT' }]);
  assert.deepStrictEqual(exits, [130]);
  const heard = [];
  proc.on('SIGTERM', (name) => heard.push(name));
  handle([{ type: 'signal', signal: 'SIGTERM' }]);
  assert.deepStrictEqual(heard, ['SIGTERM']);
  assert.deepStrictEqual(exits, [130]);
});

test('the worker’s stdout reaches its fd whole, through a pipe that is full', async () => {
  const written = [];
  let full = true;
  const write = (fd, buf, off) => {
    if (full) {
      full = false;
      throw Object.assign(new Error('resource temporarily unavailable'), {
        code: 'EAGAIN',
      });
    }
    const n = Math.min(3, buf.length - off);
    written.push(Buffer.from(buf.subarray(off, off + n)));
    return n;
  };
  const stream = fdStream(1, write);
  await new Promise((resolve, reject) =>
    stream.write('hello, world', (err) => (err ? reject(err) : resolve())),
  );
  assert.strictEqual(Buffer.concat(written).toString(), 'hello, world');
});
