// Startup notification (issue #174): the handshake that stops the
// launcher's busy cursor and tells the window manager which user action
// opened this window.
//
// The interesting decision is *when* an app counts as started. GTK says
// "when the toplevel maps"; this renderer can say something better, because
// it knows when a frame actually painted — a mapped window here is an empty
// one, the drawing lands a frame later. So the default is the first flush
// that painted, with `completeOn` for the apps that want the other answers.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import React from 'react';

import {
  createRoot,
  launchTimestamp,
  notifyStartupComplete,
} from '../src/index.js';
import {
  encodeStartupMessage,
  messageChunks,
  parseLaunchTime,
} from '../src/startup.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  await tick();
  await tick();
};

const ID = 'launcher/app.desktop/1234-0_TIME9876';

let savedEnv;
beforeEach(() => {
  savedEnv = process.env.DESKTOP_STARTUP_ID;
  delete process.env.DESKTOP_STARTUP_ID;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.DESKTOP_STARTUP_ID;
  else process.env.DESKTOP_STARTUP_ID = savedEnv;
});

/** The messages, reassembled from their 20-byte fragments. */
function messagesOf(app) {
  const out = [];
  let bytes = [];
  for (const msg of app.clientMessages) {
    if (msg.type === app._atoms.get('_NET_STARTUP_INFO_BEGIN')) bytes = [];
    bytes.push(...msg.data);
    const end = bytes.indexOf(0);
    if (end >= 0) {
      out.push(Buffer.from(bytes.slice(0, end)).toString('utf8'));
      bytes = [];
    }
  }
  return out;
}

const propertyCalls = (wnd) => wnd.calls.filter((c) => c[0] === 'setProperty');

async function mount(options = {}, element) {
  const app = createMockApp();
  const x11Root = await createRoot({ app, ...options });
  x11Root.render(
    element ?? h('window', { width: 200, height: 100 }, h('box', null)),
  );
  await settle();
  return { app, x11Root, wnd: app.windows[0] };
}

// --- the pieces ---------------------------------------------------------

test('an id carries the launch timestamp, or admits it has none', () => {
  assert.strictEqual(parseLaunchTime('foo_TIME12345'), 12345);
  assert.strictEqual(parseLaunchTime('foo'), null, 'no _TIME');
  assert.strictEqual(parseLaunchTime('foo_TIMEnotanumber'), null);
  assert.strictEqual(parseLaunchTime(''), null);
  assert.strictEqual(parseLaunchTime(undefined), null, 'never throws');
});

test('values are quoted the way the protocol parses them, not the way C does', () => {
  assert.strictEqual(
    encodeStartupMessage('remove', { ID: 'plain' }),
    'remove: ID="plain"',
  );
  assert.strictEqual(
    encodeStartupMessage('new', { ID: 'a b', NAME: 'say "hi"' }),
    'new: ID="a b" NAME="say \\"hi\\""',
  );
  assert.strictEqual(
    encodeStartupMessage('new', { ID: 'back\\slash' }),
    'new: ID="back\\\\slash"',
    'a backslash is escaped',
  );
  // the spec is explicit that `\n` means the letter n, so a real newline
  // stays a real newline rather than becoming an escape
  assert.strictEqual(
    encodeStartupMessage('new', { ID: 'a\nb' }),
    'new: ID="a\nb"',
  );
  assert.strictEqual(
    encodeStartupMessage('remove', { ID: 'x', NAME: undefined }),
    'remove: ID="x"',
    'absent fields are left out, not sent empty',
  );
});

test('a message is fragmented into nul-terminated 20-byte chunks', () => {
  const long = 'remove: ID="' + 'x'.repeat(60) + '"';
  const chunks = messageChunks(long);
  assert.ok(chunks.length > 1, 'long enough to need fragmenting');
  for (const chunk of chunks) {
    assert.strictEqual(chunk.length, 20, 'every fragment is 20 bytes');
  }
  const flat = chunks.flat();
  const end = flat.indexOf(0);
  assert.strictEqual(
    Buffer.from(flat.slice(0, end)).toString('utf8'),
    long,
    'and they reassemble to what went in',
  );
  assert.ok(
    flat.slice(0, end).every((b) => b !== 0),
    'no intermediate byte is nul',
  );

  // a message whose bytes land on an exact multiple of 20 still needs the
  // chunk carrying its terminator, or the last byte used is not a nul
  const exact = 'a'.repeat(20);
  assert.strictEqual(messageChunks(exact).length, 2);
});

// --- the handshake ------------------------------------------------------

test('the id is set on the first toplevel, before it maps', async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const { wnd, x11Root } = await mount();

  const names = wnd.calls.map((c) => (c[0] === 'setProperty' ? c[1] : c[0]));
  const mapAt = names.indexOf('map');
  assert.ok(mapAt >= 0, 'it mapped');
  assert.ok(
    names.indexOf('_NET_STARTUP_ID') >= 0 &&
      names.indexOf('_NET_STARTUP_ID') < mapAt,
    `_NET_STARTUP_ID before the map, got ${names.join(',')}`,
  );
  assert.ok(
    names.indexOf('_NET_WM_USER_TIME') >= 0 &&
      names.indexOf('_NET_WM_USER_TIME') < mapAt,
    'and _NET_WM_USER_TIME too — EWMH is about the state at map time',
  );

  const userTime = propertyCalls(wnd).find((c) => c[1] === '_NET_WM_USER_TIME');
  assert.deepStrictEqual(userTime[2], [9876], 'the launch timestamp');
  assert.strictEqual(userTime[3].type, 'CARDINAL');
  assert.strictEqual(userTime[3].format, 32);

  await x11Root.unmount();
});

test('the sequence ends on the first paint, and only once', async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const app = createMockApp();
  const x11Root = await createRoot({ app });
  x11Root.render(h('window', { width: 200, height: 100 }, h('box', null)));

  // mapped, but the frame clock has not run: nothing sent yet
  assert.strictEqual(
    app.clientMessages.length,
    0,
    'a mapped window is an empty one — the map is not the moment',
  );

  await settle();
  assert.deepStrictEqual(
    messagesOf(app),
    [`remove: ID="${ID}"`],
    'the first frame that painted ended it',
  );

  // paint again; the sequence is over
  app.windows[0]._reactX11Node.invalidate(true, null, 'test');
  await settle();
  assert.strictEqual(messagesOf(app).length, 1, 'not sent twice');

  await x11Root.unmount();
});

test('the message goes to the root, from our window, on PropertyChange', async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const { app, wnd, x11Root } = await mount();

  const sent = app.clientMessages;
  assert.ok(sent.length > 0, 'something was sent');
  for (const msg of sent) {
    assert.strictEqual(msg.destination, 1, 'to the root window');
    assert.strictEqual(msg.wid, wnd.id, 'naming a window we own');
    assert.strictEqual(msg.format, 8);
    assert.strictEqual(msg.data.length, 20);
    assert.strictEqual(
      msg.eventMask,
      0x00400000,
      'PropertyChange, not the SendClientMessage default',
    );
  }
  assert.strictEqual(
    sent[0].type,
    app._atoms.get('_NET_STARTUP_INFO_BEGIN'),
    'the first fragment opens the message',
  );

  await x11Root.unmount();
});

test('the environment variable is consumed, not merely read', async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const { x11Root } = await mount();
  assert.strictEqual(
    process.env.DESKTOP_STARTUP_ID,
    undefined,
    'a child process must not inherit a sequence that is not its own',
  );
  await x11Root.unmount();
});

test('launchTimestamp is the launch time, or null for a shell start', async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const { x11Root } = await mount();
  assert.strictEqual(launchTimestamp(), 9876);
  await x11Root.unmount();

  const bare = await mount();
  assert.strictEqual(
    launchTimestamp(),
    null,
    'no id is a real answer, not a failure',
  );
  await bare.x11Root.unmount();
});

test('no id means no properties and no traffic', async () => {
  const { app, wnd, x11Root } = await mount();
  assert.strictEqual(app.clientMessages.length, 0);
  assert.deepStrictEqual(
    propertyCalls(wnd).filter((c) => String(c[1]).startsWith('_NET_STARTUP')),
    [],
  );
  await x11Root.unmount();
});

// --- the seams ----------------------------------------------------------

test('startupNotification: false opts out entirely', async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const { app, wnd, x11Root } = await mount({ startupNotification: false });
  assert.strictEqual(app.clientMessages.length, 0, 'nothing sent');
  assert.deepStrictEqual(
    propertyCalls(wnd).filter((c) => String(c[1]).startsWith('_NET_STARTUP')),
    [],
    'and nothing set',
  );
  assert.strictEqual(
    process.env.DESKTOP_STARTUP_ID,
    ID,
    'opting out leaves the variable alone: this app is not the launchee',
  );
  await x11Root.unmount();
});

test('an id can be supplied instead of inherited', async () => {
  const { app, x11Root } = await mount({
    startupNotification: 'given_TIME99',
  });
  assert.deepStrictEqual(messagesOf(app), ['remove: ID="given_TIME99"']);
  assert.strictEqual(launchTimestamp(), 99);
  await x11Root.unmount();
});

test("completeOn: 'map' ends it at the map, GTK-style", async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const app = createMockApp();
  const x11Root = await createRoot({
    app,
    startupNotification: { completeOn: 'map' },
  });
  x11Root.render(h('window', { width: 200, height: 100 }, h('box', null)));

  // Take painting away *after* the map, so nothing can ever reach the
  // default path. Whatever arrives now was sent by the map alone — which is
  // the whole claim of this mode, and it is what an app wants when its
  // first frame is expensive and it would rather the cursor stopped early.
  const wnd = app.windows[0];
  delete wnd.getContext;

  await settle();
  assert.deepStrictEqual(
    messagesOf(app),
    [`remove: ID="${ID}"`],
    'sent from the map, with no paint anywhere in the run',
  );
  assert.strictEqual(wnd.ctx.ops.length, 0, 'and nothing painted, at all');

  await x11Root.unmount();
});

test("completeOn: 'manual' waits for the app to say so", async () => {
  process.env.DESKTOP_STARTUP_ID = ID;
  const { app, x11Root } = await mount({
    startupNotification: { completeOn: 'manual' },
  });
  assert.strictEqual(
    app.clientMessages.length,
    0,
    'painting is not the signal here',
  );

  notifyStartupComplete();
  await tick();
  assert.deepStrictEqual(messagesOf(app), [`remove: ID="${ID}"`]);

  notifyStartupComplete();
  await tick();
  assert.strictEqual(messagesOf(app).length, 1, 'idempotent');

  await x11Root.unmount();
});

test('an app that never says it is up is still let go of', async (t) => {
  // The case that would otherwise reproduce the bug this exists to fix: a
  // sequence nobody closes runs to the launcher's own 15-second timeout.
  // `manual` is the shape of it — a session that armed the backstop and
  // then heard nothing — and mock timers stand in for the ten seconds.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  process.env.DESKTOP_STARTUP_ID = ID;
  const { app, x11Root } = await mount({
    startupNotification: { completeOn: 'manual' },
  });
  assert.strictEqual(app.clientMessages.length, 0, 'nothing yet');

  t.mock.timers.tick(10_000);
  await tick();
  assert.deepStrictEqual(
    messagesOf(app),
    [`remove: ID="${ID}"`],
    'the backstop sent exactly one',
  );

  notifyStartupComplete();
  await tick();
  assert.strictEqual(messagesOf(app).length, 1, 'and it is over for good');

  await x11Root.unmount();
});

test('the session takes itself off the app once it is over', async () => {
  // the paint path reads `app._reactX11Startup` on every frame that draws;
  // clearing it is what keeps that to one property read for the life of
  // the process rather than a live call
  process.env.DESKTOP_STARTUP_ID = ID;
  const { app, x11Root } = await mount();
  assert.strictEqual(app._reactX11Startup, null);
  await x11Root.unmount();
});
