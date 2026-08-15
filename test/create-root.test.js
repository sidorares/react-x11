// createRoot's contract: an options object, one connection per root, and a
// connection the root closes only when it opened it (#114).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { StaticFontSource } from 'ntk';
import { createRoot } from '../src/index.js';
import { setDesktopSettingsForTests } from '../src/desktopsettings.js';
import { createMockApp } from './helpers/mock-app.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const win = (title) =>
  h('window', { width: 60, height: 40, title }, h('box', { style: {} }));

const require = createRequire(import.meta.url);
const fontDir = join(
  dirname(require.resolve('katex/package.json')),
  'dist',
  'fonts',
);

/** A stream onto node-x11's in-process X server, so a root can open a real
 * connection of its own with no $DISPLAY. */
function headlessStream() {
  const server = xserver.createServer({ width: 320, height: 240 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  const fontSource = new StaticFontSource();
  fontSource.add(readFileSync(join(fontDir, 'KaTeX_Main-Regular.ttf')), {
    family: 'Test Main',
  });
  fontSource.alias('sans-serif', 'Test Main');
  return { stream: clientEnd, fontSource };
}

test('two roots are two trees, not one replacing the other', async () => {
  // the memoised connection made both createRoot() calls resolve the same
  // app, and `roots` was keyed by it — so the second render silently
  // replaced the first root's tree
  const app = createMockApp();
  const a = await createRoot({ app });
  const b = await createRoot({ app });
  a.render(win('a'));
  b.render(win('b'));
  await tick();

  assert.strictEqual(app.windows.length, 2, 'both trees mounted');
  await a.unmount();
  await b.unmount();
});

test('a root that opened the connection closes it on unmount', async () => {
  const root = await createRoot(headlessStream());
  root.render(win('owned'));
  await tick();
  assert.notStrictEqual(root.app.X._closing, true, 'up while rendering');

  await root.unmount();
  assert.strictEqual(
    root.app.X._closing,
    true,
    'the socket it opened is closed, so the process can exit',
  );
});

test('a borrowed connection is never closed', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(win('borrowed'));
  await tick();
  await root.unmount();
  assert.strictEqual(app.closed, 0, 'not ours to close');
});

test('unmount is idempotent', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  root.render(win('x'));
  await tick();
  await root.unmount();
  await root.unmount();
  assert.strictEqual(app.closed, 0);
});

test('the old createRoot(app) signature throws, naming the new one', async () => {
  const app = createMockApp();
  await assert.rejects(() => createRoot(app), /createRoot\(\{ app \}\)/);
});

test('createRoot exposes the connection it rendered through', async () => {
  const app = createMockApp();
  const root = await createRoot({ app });
  assert.strictEqual(root.app, app);
  await root.unmount();
});

test('onDisconnect reports the connection ending, once', async () => {
  const app = createMockApp();
  const seen = [];
  const root = await createRoot({
    app,
    onDisconnect: (reason, err) => seen.push([reason, err?.message]),
  });
  root.render(win('x'));
  await tick();

  app.X.emit('end');
  assert.deepStrictEqual(seen, [['closed', undefined]], 'server exit');

  app.X.emit('end');
  assert.strictEqual(seen.length, 1, 'a dropped connection does not end twice');

  await root.unmount();
});

test('onDisconnect tells a transport failure from an X protocol error', async () => {
  const app = createMockApp();
  const seen = [];
  const root = await createRoot({
    app,
    onDisconnect: (reason, err) => seen.push([reason, err?.message]),
  });
  root.render(win('x'));
  await tick();

  // an X protocol error carries an opcode, and is ntk's onXError business
  const protocolError = new Error('Bad window');
  protocolError.majorOpcode = 2;
  protocolError.seq = 9;
  app.X.emit('error', protocolError);
  assert.deepStrictEqual(seen, [], 'the connection is still up');

  const transport = new Error('ECONNRESET');
  transport.code = 'ECONNRESET';
  app.X.emit('error', transport);
  assert.deepStrictEqual(seen, [['error', 'ECONNRESET']]);

  await root.unmount();
});

test('unmounting is not a disconnect', async () => {
  const app = createMockApp();
  const seen = [];
  const root = await createRoot({ app, onDisconnect: (r) => seen.push(r) });
  root.render(win('x'));
  await tick();
  await root.unmount();
  app.X.emit('end');
  assert.deepStrictEqual(seen, [], 'we closed it, so nothing was lost');
});

test('error handlers belong to the root, not the module', async () => {
  const app = createMockApp();
  const caught = [];
  const root = await createRoot({
    app,
    onUncaughtError: (error) => caught.push(error.message),
  });
  const Boom = () => {
    throw new Error('boom');
  };
  try {
    root.render(h('window', { width: 10, height: 10 }, h(Boom)));
  } catch {
    // React rethrows after reporting; the report is what is under test
  }
  assert.deepStrictEqual(caught, ['boom']);
  await root.unmount();
});

test('the legacy render()/unmountComponentAtNode() pair is gone', async () => {
  // Retired with the module-level connection cache they depended on (#114).
  // Asserted rather than assumed: they were the reason two roots could
  // share one fiber tree, and a re-export added back by reflex would bring
  // the sharing back with it.
  const mod = await import('../src/index.js');
  assert.strictEqual(mod.render, undefined);
  assert.strictEqual(mod.unmountComponentAtNode, undefined);
  assert.deepStrictEqual(Object.keys(mod.default), ['createRoot']);
});

test('a root that borrows a connection can outlive another root on it', async () => {
  // What the shared cache made impossible: `roots` was keyed by the
  // connection, so a second root on one app was the *same* fiber root and
  // unmounting either took down both trees.
  const app = createMockApp();
  const a = await createRoot({ app });
  const b = await createRoot({ app });
  a.render(win('a'));
  b.render(win('b'));
  await tick();
  assert.strictEqual(app.windows.length, 2, 'two independent trees');

  const [first, second] = app.windows;
  await a.unmount();
  await tick();
  assert.ok(
    first.calls.some(([name]) => name === 'destroy'),
    "unmounting the first root destroyed the first root's window",
  );
  assert.ok(
    !second.calls.some(([name]) => name === 'destroy'),
    'and left the second tree standing on the same connection',
  );
});

test('a caret stops blinking when the connection closes under it', async () => {
  // A focused field arms an interval that repaints twice a second for as
  // long as it holds focus, and closing the connection does not blur it —
  // an app that closes its own client, or a test that closes the app it
  // lent the root. The tick after the close used to reach the wire and
  // throw "client is in closing state" out of the frame clock, where
  // nothing is waiting to catch it: an uncaught exception with no test
  // still running to attribute it to, which is what made
  // test/selection-batch.test.js flake on the slower CI runners.
  const root = await createRoot(headlessStream());
  const ref = React.createRef();
  root.render(
    h(
      'window',
      { width: 60, height: 40 },
      h('textinput', { ref, defaultValue: 'x', style: { width: 40 } }),
    ),
  );
  await tick();
  const input = ref.current;
  setDesktopSettingsForTests(root.app, { caretBlinkMs: 5 });
  input.defaultFocus();
  assert.ok(input._blinkTimer, 'the caret is blinking');

  // the first paint off the wire before the close, so the timer is the only
  // thing left that can talk to the connection
  await new Promise((resolve) => root.app.X.GetInputFocus(() => resolve()));
  await root.app.close();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(
    input._blinkTimer,
    null,
    'the first tick on a closing connection disarms the timer',
  );
});
