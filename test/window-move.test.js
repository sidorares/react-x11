// A window move is not a resize. The window manager reports both through
// ConfigureNotify (ntk's 'resize' event), and a WM that moves windows
// opaquely — Compiz, KWin, Mutter — sends one per pointer step of a drag.
// The window's own coordinate space is untouched by where it sits on
// screen, so a pure move must cost no layout and no paint: before the
// guard in WindowNode's 'resize' listener, every drag step was a full
// relayout plus a FULL WINDOW repaint (30 moves = 30 full frames, measured
// against Compiz on glamor/virgl where each such frame is a GPU round
// trip through the VM).
//
// The frame hook from trace-registry is the observer here because it is
// the same signal REACT_X11_TRACE prints as "FULL WINDOW": a frame fires
// it exactly when a flush painted, with the rects it painted. No frames
// through the hook means no pixels touched — the assertion the fix is for.
//
// Test order matters: the React-driven cases run before the X-driven
// resize, so React's idea of the window size stays in step with the
// server's. (An X resize the app never rendered leaves the props stale,
// and the next commit would legitimately configure the size back.)
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';
import { hooks } from '../src/trace-registry.js';

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

const W = 240;
const H = 200;

async function headlessApp() {
  const server = xserver.createServer({ width: 400, height: 400 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return createClient({ stream: clientEnd, fontSource });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `fn()` is truthy, or fail after `ms`. */
async function waitFor(fn, what, ms = 1000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const app = await headlessApp();
const x11Root = await createRoot({ app });

const frames = [];
hooks.frame = (info) => frames.push(info);
after(() => {
  hooks.frame = null;
  return app.close();
});

const element = (x, y, width = W, height = H) =>
  React.createElement(
    'window',
    { x, y, width, height, style: { backgroundColor: '#f5f6fa' } },
    React.createElement(
      'box',
      { style: { flexGrow: 1, padding: 8 } },
      React.createElement('text', { style: { fontSize: 12 } }, 'hello'),
    ),
  );

const instance = await new Promise((resolve) =>
  x11Root.render(element(10, 10), resolve),
);
const node = instance._reactX11Node;
node._scheduled = false;
node.flush();
// let the mount's own ConfigureNotify echo (same size as laid out) drain
await sleep(120);
frames.length = 0;

test('a pure window move paints nothing', async () => {
  app.X.ConfigureWindow(node.window.id, { x: 60, y: 40 });
  // the event must actually arrive — otherwise this test passes vacuously
  await waitFor(() => node.window.x === 60, 'the move ConfigureNotify');
  await sleep(120); // two paced-frame intervals, room for a scheduled flush
  assert.strictEqual(node.needsLayout, false, 'a move must not dirty layout');
  assert.deepStrictEqual(
    frames.map((f) => f.rects),
    [],
    'a move must not paint',
  );
});

test('a React x/y-only prop change moves the window without painting', async () => {
  frames.length = 0;
  await new Promise((resolve) => x11Root.render(element(120, 90), resolve));
  await waitFor(() => node.window.x === 120, 'the ConfigureWindow move');
  await sleep(120);
  assert.deepStrictEqual(
    frames.map((f) => f.rects),
    [],
    'an x/y-only commit must not paint',
  );
});

test('a React size prop change still repaints', async () => {
  frames.length = 0;
  await new Promise((resolve) =>
    x11Root.render(element(120, 90, W + 40, H + 20), resolve),
  );
  await waitFor(() => frames.length > 0, 'the props-resize repaint');
  await waitFor(
    () => node.abs.width === W + 40,
    'layout consuming the new width',
  );
});

test('a WM-driven resize still lays out and repaints', async () => {
  // drain the props-resize echo first so its frame is not counted here
  await sleep(120);
  frames.length = 0;
  app.X.ConfigureWindow(node.window.id, { width: W + 100, height: H + 60 });
  await waitFor(() => frames.length > 0, 'the resize repaint');
  assert.strictEqual(node.abs.width, W + 100, 'layout consumed the new width');
  assert.ok(
    frames.some((f) => f.reasons?.includes('resize')),
    `the frame names its reason (got ${JSON.stringify(frames.map((f) => f.reasons))})`,
  );
});

// Where the window is on screen cannot be read off ConfigureNotify — a
// reparenting WM makes those coordinates frame-relative — so it costs a
// TranslateCoordinates round trip, and popups anchored to the window need
// it. ntk's `ev.moved` (sidorares/ntk#184) says whether the position
// changed at all, which is what keeps a resize drag from paying for one
// per frame.
let translates = 0;
const countTranslates = () => {
  const real = app.X.TranslateCoordinates.bind(app.X);
  app.X.TranslateCoordinates = (...args) => {
    translates++;
    return real(...args);
  };
};
countTranslates();

test('a resize that did not move the window asks the server nothing', async () => {
  await sleep(120);
  translates = 0;
  app.X.ConfigureWindow(node.window.id, { width: W + 120, height: H + 80 });
  await waitFor(() => node.window.width === W + 120, 'the resize');
  await sleep(120);
  assert.strictEqual(
    translates,
    0,
    'a pure resize must not re-ask where the window is',
  );
});

test('a move still refreshes the screen origin', async () => {
  await sleep(120);
  translates = 0;
  app.X.ConfigureWindow(node.window.id, { x: 33, y: 44 });
  await waitFor(() => node.window.x === 33, 'the move');
  await waitFor(() => translates > 0, 'the screen-origin refresh');
  await waitFor(
    () => node.window._screenOrigin?.x === 33,
    'the origin the server answered with',
  );
});

test('a reparent refreshes the screen origin on its own', async () => {
  await sleep(120);
  // stand in for a window manager framing the window: a parent at a known
  // offset, which is exactly the case where ConfigureNotify coordinates
  // stop meaning screen coordinates
  const frame = app.X.AllocID();
  app.X.CreateWindow(frame, app.X.display.screen[0].root, 70, 90, 400, 400);
  app.X.MapWindow(frame);
  translates = 0;
  app.X.ReparentWindow(node.window.id, frame, 0, 0);
  await waitFor(() => translates > 0, 'the reparent refresh');
  await waitFor(
    () => node.window._screenOrigin?.x === 70,
    `the framed origin (got ${JSON.stringify(node.window._screenOrigin)})`,
  );
});
