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
  Thumbnails,
  WindowManager,
  frameHeight,
  frameWidth,
  parseNetWmIcon,
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
async function startWM(wmApp, options) {
  const wm = new WindowManager(wmApp, options);
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

// _NET_WM_ICON packs every size the application offers into one property,
// each as [width, height, width*height ARGB pixels].
const iconBlock = (size, argb) => [
  size,
  size,
  ...Array(size * size).fill(argb),
];

test('parseNetWmIcon picks a size and converts ARGB to RGBA', () => {
  const words = [...iconBlock(8, 0xff112233), ...iconBlock(32, 0xff445566)];

  // the smallest one that is still big enough for what we draw
  assert.equal(parseNetWmIcon(words, 16).width, 32);
  assert.equal(parseNetWmIcon(words, 8).width, 8);
  // nothing is big enough: take the largest there is rather than nothing
  assert.equal(parseNetWmIcon(words, 64).width, 32);

  const icon = parseNetWmIcon(iconBlock(2, 0x80aabbcc), 2);
  assert.equal(icon.width, 2);
  assert.equal(icon.data.length, 2 * 2 * 4);
  assert.deepEqual([...icon.data.subarray(0, 4)], [0xaa, 0xbb, 0xcc, 0x80]);
});

test('parseNetWmIcon rejects a truncated or empty property', () => {
  assert.equal(parseNetWmIcon([], 16), null);
  assert.equal(parseNetWmIcon([0, 0], 16), null);
  // claims 4x4 but carries three pixels
  assert.equal(parseNetWmIcon([4, 4, 1, 2, 3], 16), null);
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

test("a client's _NET_WM_ICON is read, and re-read when it changes", async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const app = clientApp.createWindow({ width: 200, height: 150 });
  await app.setProperty('_NET_WM_ICON', iconBlock(16, 0xff203040), {
    type: 'CARDINAL',
  });
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');

  const id = [...wm.clients.keys()][0];
  assert.equal(wm.clients.get(id).icon?.width, 16, 'icon read at manage time');
  assert.deepEqual(
    [...wm.clients.get(id).icon.data.subarray(0, 4)],
    [0x20, 0x30, 0x40, 0xff],
  );

  // swapping the icon arrives as a PropertyNotify naming _NET_WM_ICON
  await app.setProperty('_NET_WM_ICON', iconBlock(8, 0xffaabbcc), {
    type: 'CARDINAL',
  });
  await until(
    wmApp,
    () => wm.clients.get(id).icon?.width === 8,
    'the new icon to be picked up',
  );
  assert.deepEqual(
    [...wm.clients.get(id).icon.data.subarray(0, 4)],
    [0xaa, 0xbb, 0xcc, 0xff],
  );

  await wmApp.close();
  await clientApp.close();
});

test('a client with no icon is managed all the same', async () => {
  const { wmApp, clientApp } = await headlessPair();
  const { wm } = await startWM(wmApp);

  const app = clientApp.createWindow({ width: 200, height: 150 });
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');

  assert.equal(wm.clients.get(app.id).icon, null, 'no icon, not an error');

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

// --- previews ---------------------------------------------------------------
//
// The real provider needs a server with Composite, which the in-process one
// does not have (it registers RENDER and nothing else) — so `openThumbnails`
// is the seam and these drive both sides of it: a fake for the wiring, and
// the real `Thumbnails` against a fake extension for the pixmap bookkeeping.

/** Records what the window manager asks a provider to do. */
function recordingThumbnails() {
  const calls = [];
  const drawables = new Map();
  return {
    calls,
    provider: {
      track: (id) => calls.push(['track', id]),
      get: (id) => drawables.get(id) ?? null,
      capture: async (id) => {
        const drawable = { id: 0x900 + id, width: 40, height: 30, depth: 24 };
        drawables.set(id, drawable);
        calls.push(['capture', id]);
        return drawable;
      },
      invalidate: (id) => {
        drawables.delete(id);
        calls.push(['invalidate', id]);
      },
      forget: (id) => calls.push(['forget', id]),
    },
  };
}

/** A managed client, framed, with `wm` already running. */
async function oneFramedClient(options) {
  const { wmApp, clientApp } = await headlessPair();
  const { wm, frames } = await startWM(wmApp, options);
  const app = clientApp.createWindow({ width: 300, height: 200 });
  app.map();
  await until(wmApp, () => wm.clients.size === 1, 'the client to be managed');
  wm.attachFakeFrames();
  await settle(wmApp);
  return { wmApp, clientApp, wm, frames, app };
}

test('a server without Composite manages windows with no previews at all', async () => {
  // the default opener, against a server that really has no Composite
  const { wmApp, clientApp, wm, app } = await oneFramedClient();

  assert.equal(wm.thumbnails, null, 'no provider where there is no extension');
  assert.equal(wm.getSnapshot()[0].thumbnail, null);

  // and the call the UI makes is a no-op rather than a throw, which is what
  // lets the React side ask for a preview without checking first
  let woken = 0;
  wm.subscribe(() => woken++);
  await wm.peek(app.id);
  assert.equal(woken, 0, 'nothing to publish, nothing to re-render for');
  assert.equal(wm.getSnapshot()[0].thumbnail, null);

  await wmApp.close();
  await clientApp.close();
});

test('a frame is tracked when it is attached and released when the client goes', async () => {
  const { calls, provider } = recordingThumbnails();
  const { wmApp, clientApp, wm, app } = await oneFramedClient({
    openThumbnails: async () => provider,
  });

  assert.deepEqual(calls, [['track', app.id]], 'redirected at attach time');

  app.destroy();
  await until(wmApp, () => wm.clients.size === 0, 'the client to be dropped');
  assert.deepEqual(calls.at(-1), ['forget', app.id]);

  await wmApp.close();
  await clientApp.close();
});

test('peek publishes a preview into the snapshot, and wakes React once', async () => {
  const { provider } = recordingThumbnails();
  const { wmApp, clientApp, wm, app } = await oneFramedClient({
    openThumbnails: async () => provider,
  });

  let woken = 0;
  wm.subscribe(() => woken++);
  assert.equal(wm.getSnapshot()[0].thumbnail, null, 'nothing until asked');

  await wm.peek(app.id);
  assert.equal(woken, 1);
  assert.deepEqual(wm.getSnapshot()[0].thumbnail, {
    id: 0x900 + app.id,
    width: 40,
    height: 30,
    depth: 24,
  });

  await wmApp.close();
  await clientApp.close();
});

test('a resize drops the preview and a move keeps it', async () => {
  const { calls, provider } = recordingThumbnails();
  const { wmApp, clientApp, wm, app } = await oneFramedClient({
    openThumbnails: async () => provider,
  });
  await wm.peek(app.id);

  // a drag is a move: the client rides along inside the frame at its own
  // size, so the pixmap the server named is still the right one
  wm.setGeometry(app.id, { x: 120, y: 90 });
  assert.ok(wm.getSnapshot()[0].thumbnail, 'a move keeps the preview');
  assert.equal(
    calls.filter(([what]) => what === 'invalidate').length,
    0,
    'and asks for nothing',
  );

  // a resize ends the generation the pixmap belonged to
  wm.setGeometry(app.id, { width: 420 });
  assert.deepEqual(calls.at(-1), ['invalidate', app.id]);
  assert.equal(wm.getSnapshot()[0].thumbnail, null);

  // as does maximizing, which is a resize by another name
  await wm.peek(app.id);
  wm.toggleMaximize(app.id);
  assert.deepEqual(calls.at(-1), ['invalidate', app.id]);

  await wmApp.close();
  await clientApp.close();
});

/**
 * A Composite that does what the server does: `NameWindowPixmap` really
 * creates a pixmap at the id the caller allocated, so `Pixmap.adopt` can
 * measure it and `FreePixmap` can take it away again. Without that the test
 * would only be checking that we called a function.
 */
function fakeComposite(X, { width, height, depth = 24 }, root) {
  const calls = { redirected: [], unredirected: [], named: [] };
  return {
    calls,
    Redirect: { Automatic: 0, Manual: 1 },
    RedirectWindow: (window, type) => calls.redirected.push([window, type]),
    UnredirectWindow: (window) => calls.unredirected.push(window),
    NameWindowPixmap: (window, pixmap) => {
      calls.named.push([window, pixmap]);
      X.CreatePixmap(pixmap, root, depth, width, height);
    },
  };
}

/**
 * Run `fn` with ntk's warning about unroutable X errors turned off.
 *
 * Asking about a pixmap that is meant to be gone answers with a
 * BadDrawable, and node-x11 emits those on the client as well as handing
 * them to the callback — so the tests below would print a warning per
 * assertion, as if something had gone wrong. Settles before restoring, so
 * the error the request provokes is still inside the quiet window.
 */
async function withoutXErrorWarnings(app, fn) {
  const previous = app.options.onXError;
  app.options.onXError = () => {};
  try {
    const answer = await fn();
    await settle(app);
    return answer;
  } finally {
    app.options.onXError = previous;
  }
}

/** Does `pixmap` still exist? GetGeometry is the cheapest way to ask. */
const alive = (app, pixmap) =>
  withoutXErrorWarnings(
    app,
    () =>
      new Promise((resolve) =>
        app.X.GetGeometry(pixmap, (err) => resolve(!err)),
      ),
  );

test('Thumbnails names a fresh pixmap each time and measures it once', async () => {
  const { wmApp, clientApp, wm, app } = await oneFramedClient();
  const X = wmApp.X;
  const root = wmApp.display.screen[0].root;
  const composite = fakeComposite(X, { width: 308, height: 230 }, root);
  const thumbnails = new Thumbnails(wmApp, composite);

  thumbnails.track(app.id, wm.clients.get(app.id).frame);
  assert.equal(composite.calls.redirected.length, 1);
  assert.equal(
    composite.calls.redirected[0][1],
    composite.Redirect.Automatic,
    'Automatic: the server keeps painting the window itself',
  );
  assert.equal(thumbnails.get(app.id), null, 'tracking names nothing yet');

  const first = await thumbnails.capture(app.id);
  assert.equal(first.width, 308, 'geometry comes from the server, not a guess');
  assert.equal(first.height, 230);
  assert.equal(first.depth, 24);
  assert.deepEqual(thumbnails.get(app.id), first);

  // A second name is a different id for the same window contents — which is
  // the whole mechanism behind a live preview, because the id is what tells
  // <image> its source changed.
  const second = await thumbnails.capture(app.id);
  assert.notEqual(second.id, first.id);
  assert.deepEqual(
    [second.width, second.height, second.depth],
    [308, 230, 24],
    'and the same rectangle',
  );

  // one generation behind: nothing has composited from `first` since React
  // was handed `second`, but it was still alive while it might have been
  assert.equal(
    await alive(wmApp, first.id),
    true,
    'kept for one more generation',
  );
  const third = await thumbnails.capture(app.id);
  assert.equal(await alive(wmApp, first.id), false, 'and freed by the next');
  assert.equal(await alive(wmApp, second.id), true);
  assert.equal(await alive(wmApp, third.id), true);

  await wmApp.close();
  await clientApp.close();
});

test('Thumbnails reports nothing when the name did not land', async () => {
  const { wmApp, clientApp, wm, app } = await oneFramedClient();
  // a Composite whose NameWindowPixmap creates nothing — what a frame that
  // is not viewable yet looks like from here
  const composite = {
    Redirect: { Automatic: 0 },
    RedirectWindow: () => {},
    UnredirectWindow: () => {},
    NameWindowPixmap: () => {},
  };
  const thumbnails = new Thumbnails(wmApp, composite);
  thumbnails.track(app.id, wm.clients.get(app.id).frame);

  assert.equal(
    await withoutXErrorWarnings(wmApp, () => thumbnails.capture(app.id)),
    null,
    'an id that names nothing is reported, not handed on to XRender',
  );
  assert.equal(thumbnails.get(app.id), null);

  await wmApp.close();
  await clientApp.close();
});

test('forgetting a tracked frame frees every pixmap it named', async () => {
  const { wmApp, clientApp, wm, app } = await oneFramedClient();
  const X = wmApp.X;
  const root = wmApp.display.screen[0].root;
  const composite = fakeComposite(X, { width: 308, height: 230 }, root);
  const thumbnails = new Thumbnails(wmApp, composite);
  const frame = wm.clients.get(app.id).frame;

  thumbnails.track(app.id, frame);
  const first = await thumbnails.capture(app.id);
  const second = await thumbnails.capture(app.id);

  thumbnails.forget(app.id);
  await settle(wmApp);
  assert.equal(await alive(wmApp, first.id), false, 'the retired one goes too');
  assert.equal(await alive(wmApp, second.id), false);
  assert.equal(thumbnails.get(app.id), null);
  // The redirect is left alone on purpose: it dies with the frame, which is
  // about to be unmounted, and node-x11's UnredirectWindow is a BadLength on
  // a real server anyway — sidorares/node-x11#292.
  assert.deepEqual(composite.calls.unredirected, []);

  await wmApp.close();
  await clientApp.close();
});
