// The window-manager example, headless. node-x11's in-process X server
// redirects substructure requests (x11 >= 3.2.0), so a WM can be driven end
// to end without a display: a second connection plays the application.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import {
  BORDER,
  TASKBAR_H,
  TITLE_H,
  WindowManager,
  frameHeight,
  frameWidth,
  resizeRect,
} from '../examples/wm-core.js';

const SCREEN = { width: 800, height: 600 };

async function headlessPair() {
  const server = xserver.createServer(SCREEN);
  const connect = async () => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({
      stream: clientEnd,
      fontSource: new StaticFontSource(),
    });
  };
  return { server, wmApp: await connect(), clientApp: await connect() };
}

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

/**
 * Drain round trips until `predicate` holds. Taking a window under
 * management is a chain of awaited replies — size hints, title,
 * WM_TRANSIENT_FOR — so a fixed number of settles is a guess; this is not.
 */
async function until(app, predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await settle(app);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A window manager with a fake frame per client — this tests wm-core, not JSX. */
async function startWM(wmApp) {
  const wm = new WindowManager(wmApp);
  await wm.start();
  // React normally hands the frame over once it has realized the <window>;
  // here the test plays that part.
  const frames = new Map();
  wm.attachFakeFrames = () => {
    for (const client of wm.clients.values()) {
      if (client.frame) continue;
      const frame = wmApp.createWindow({
        x: client.x,
        y: client.y,
        width: frameWidth(client.width),
        height: frameHeight(client.height),
      });
      frames.set(client.id, frame);
      wm.attachFrame(client.id, frame);
    }
  };
  return { wm, frames };
}

// --- the pure part ----------------------------------------------------------

test('resizeRect pins the edge the handle is not dragging', () => {
  const start = { x: 100, y: 50, width: 200, height: 120 };
  const limits = { minWidth: 80, minHeight: 40, maxWidth: 400, maxHeight: 300 };

  const east = resizeRect(start, 'e', 40, 0, limits);
  assert.deepEqual(east, { x: 100, y: 50, width: 240, height: 120 });

  // dragging west moves x and width together: the right edge stays at 300
  const west = resizeRect(start, 'w', 40, 0, limits);
  assert.equal(west.x + west.width, 300);
  assert.equal(west.x, 140);

  const north = resizeRect(start, 'n', 0, 30, limits);
  assert.equal(north.y + north.height, 170, 'bottom edge stays');

  const corner = resizeRect(start, 'se', 50, 60, limits);
  assert.deepEqual(corner, { x: 100, y: 50, width: 250, height: 180 });
});

test('resizeRect stops moving when the size hits its limit', () => {
  const start = { x: 100, y: 50, width: 200, height: 120 };
  const limits = {
    minWidth: 150,
    minHeight: 100,
    maxWidth: 400,
    maxHeight: 300,
  };

  // asking to shrink past the minimum from the west: width clamps AND the
  // window stops sliding, or it would keep moving with its far edge pinned
  const west = resizeRect(start, 'w', 999, 0, limits);
  assert.equal(west.width, 150);
  assert.equal(west.x + west.width, 300, 'right edge still pinned');

  const north = resizeRect(start, 'n', 0, 999, limits);
  assert.equal(north.height, 100);
  assert.equal(north.y + north.height, 170, 'bottom edge still pinned');
});

// --- against a real server --------------------------------------------------

test('a mapped client is framed, reparented and focused', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm, frames } = await startWM(wmApp);

  const app = clientApp.createWindow({
    width: 300,
    height: 200,
    title: 'hello',
  });
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');

  const client = [...wm.clients.values()][0];
  assert.equal(client.title, 'hello', 'title read from the client');
  assert.equal(client.width, 300);
  assert.equal(client.height, 200);

  wm.attachFakeFrames();
  await settle(wmApp);

  const frame = frames.get(client.id);
  const tree = await new Promise((resolve, reject) =>
    frame.queryTree((err, res) => (err ? reject(err) : resolve(res))),
  );
  assert.deepEqual(
    tree.children.map((w) => w.id),
    [app.id],
    'the client lives inside the frame',
  );
  assert.equal(wm.focused, app.id, 'and takes the focus once it is viewable');

  await wmApp.close();
  await clientApp.close();
});

test('size hints constrain what the window manager will do', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const app = clientApp.createWindow({ width: 300, height: 200 });
  app.setSizeHints({
    minWidth: 250,
    minHeight: 150,
    maxWidth: 500,
    maxHeight: 400,
  });
  await settle(clientApp);
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');

  const client = [...wm.clients.values()][0];
  assert.equal(client.minWidth, 250);
  assert.equal(client.maxHeight, 400);

  wm.attachFakeFrames();
  wm.setGeometry(client.id, { width: 10, height: 10 });
  assert.equal(wm.clients.get(client.id).width, 250, 'clamped to the minimum');
  assert.equal(wm.clients.get(client.id).height, 150);

  wm.setGeometry(client.id, { width: 9999, height: 9999 });
  assert.equal(wm.clients.get(client.id).width, 500, 'clamped to the maximum');
  assert.equal(wm.clients.get(client.id).height, 400);

  await wmApp.close();
  await clientApp.close();
});

test('a client asking to resize itself is answered, honouring the value mask', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const app = clientApp.createWindow({ width: 300, height: 200 });
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');
  wm.attachFakeFrames();
  await settle(wmApp);

  const client = [...wm.clients.values()][0];
  const before = { x: client.x, y: client.y };

  app.resize(360, 240); // CWWidth | CWHeight only
  await until(
    wmApp,
    () => wm.clients.get(client.id).width === 360,
    'the configure request to be honoured',
  );

  const after = wm.clients.get(client.id);
  assert.equal(after.width, 360, 'the size it asked for');
  assert.equal(after.height, 240);
  assert.equal(
    after.x,
    before.x,
    'position untouched — it was not in the mask',
  );
  assert.equal(after.y, before.y);

  await wmApp.close();
  await clientApp.close();
});

test('maximize fills the work area and restores to where it was', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const app = clientApp.createWindow({ width: 300, height: 200 });
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');
  wm.attachFakeFrames();

  const id = [...wm.clients.keys()][0];
  const before = { ...wm.clients.get(id) };

  wm.toggleMaximize(id);
  const max = wm.clients.get(id);
  assert.equal(max.maximized, true);
  assert.equal(frameWidth(max.width), SCREEN.width, 'frame spans the screen');
  assert.equal(
    frameHeight(max.height),
    SCREEN.height - TASKBAR_H,
    'and stops at the taskbar',
  );

  wm.toggleMaximize(id);
  const restored = wm.clients.get(id);
  assert.equal(restored.maximized, false);
  assert.equal(restored.x, before.x);
  assert.equal(restored.y, before.y);
  assert.equal(restored.width, before.width);
  assert.equal(restored.height, before.height);

  await wmApp.close();
  await clientApp.close();
});

test('a destroyed client is dropped and the focus moves on', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const first = clientApp.createWindow({ width: 200, height: 150 });
  first.map();
  await until(wmApp, () => wm.clients.size === 1, 'the first client');
  wm.attachFakeFrames();
  const second = clientApp.createWindow({ width: 200, height: 150 });
  second.map();
  await until(wmApp, () => wm.clients.size === 2, 'the second client');
  wm.attachFakeFrames();
  await settle(wmApp);

  assert.equal(wm.focused, second.id, 'the newest window has the focus');

  second.destroy();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be forgotten');
  assert.equal(wm.focused, first.id, 'focus fell back to what is left');

  await wmApp.close();
  await clientApp.close();
});

test('an override-redirect window is left alone', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const menu = clientApp.createWindow({
    width: 120,
    height: 80,
    overrideRedirect: true,
  });
  menu.map();
  // a normal window mapped after it: once this one is managed we know the
  // menu was skipped rather than merely still in flight
  const normal = clientApp.createWindow({ width: 200, height: 150 });
  normal.map();
  await until(wmApp, () => wm.clients.size === 1, 'the normal window');

  assert.deepEqual(
    [...wm.clients.keys()],
    [normal.id],
    'menus and tooltips are not ours to frame',
  );
  const attrs = await wmApp.createWindow({ id: menu.id }).getAttributes();
  assert.equal(attrs.mapState, 2, 'the menu mapped itself');

  await wmApp.close();
  await clientApp.close();
});

test('a second window manager is refused', async () => {
  const { wmApp, clientApp } = await headlessPair();
  await startWM(wmApp);

  await assert.rejects(
    () => new WindowManager(clientApp).start(),
    /another window manager is already running/,
  );

  await wmApp.close();
  await clientApp.close();
});

test('the frame is the client plus its decoration', () => {
  assert.equal(frameWidth(300), 300 + 2 * BORDER);
  assert.equal(frameHeight(200), 200 + 2 * BORDER + TITLE_H);
});
