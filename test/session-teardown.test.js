// A session a root starts on its connection — XSETTINGS, the compositing
// watch — takes what it put there with it when the root goes. Both marked
// themselves stopped and left their event listeners on the connection, each
// checking `stopped` and returning, for every event, for good, and the 1x1
// window XFixes addressed their notifications to. An app that mounts one
// root after another on the same connection, a test suite or a hot reload,
// gained listeners and windows a root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { beginXSettings, endXSettings } from '../src/xsettings.js';
import { beginCompositing, endCompositing } from '../src/compositing.js';

const h = React.createElement;

async function connect(t) {
  const server = xserver.createServer({ width: 400, height: 300 });
  const [serverEnd, clientEnd] = xserver.createStreamPair();
  server.addClientStream(serverEnd);
  // No shared glyph cache: the first text a connection draws elects it the
  // display's glyph directory, which puts a listener on the connection for
  // good — several round trips later, awaited by nothing. Counted against a
  // root, it is a leak whenever a loaded runner lands it after the count
  // was taken.
  const app = await createClient({ stream: clientEnd, sharedGlyphs: false });
  t.after(() => app.close());
  return app;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

for (const [name, begin, end] of [
  ['XSETTINGS', beginXSettings, endXSettings],
  ['compositing', beginCompositing, endCompositing],
]) {
  test(`a ${name} session taken down takes its listeners and its window with it`, async (t) => {
    const app = await connect(t);
    const X = app.X;
    // The in-process server has no XFixes; one that answers is what makes a
    // session create its window, so the request is answered here.
    const fixes = {
      firstEvent: 200,
      SelectionEventMask: {
        SetSelectionOwner: 1,
        SelectionWindowDestroy: 2,
        SelectionClientClose: 4,
      },
      SelectSelectionInput() {},
    };
    const require = X.require.bind(X);
    X.require = (ext, cb) =>
      ext === 'fixes' ? cb(null, fixes) : require(ext, cb);
    const created = [];
    const destroyed = [];
    const createWindow = X.CreateWindow.bind(X);
    X.CreateWindow = (id, ...rest) => {
      created.push(id);
      return createWindow(id, ...rest);
    };
    const destroyWindow = X.DestroyWindow.bind(X);
    X.DestroyWindow = (id, ...rest) => {
      destroyed.push(id);
      return destroyWindow(id, ...rest);
    };
    const before = X.listenerCount('event');
    for (let i = 0; i < 5; i++) {
      await begin(app);
      await tick(); // the watch is started, not awaited
      end(app);
    }
    assert.equal(X.listenerCount('event'), before, 'no listener left behind');
    assert.equal(created.length, 5, 'a window a session');
    assert.deepEqual(destroyed, created, 'and each destroyed with it');
  });
}

test('roots mounted one after another on one connection leave nothing on it', async (t) => {
  const app = await connect(t);
  const cycle = async () => {
    const root = await createRoot({ app });
    await new Promise((resolve) =>
      root.render(
        h('window', { width: 100, height: 80 }, h('text', {}, 'hi')),
        resolve,
      ),
    );
    await tick();
    await root.unmount();
    await tick();
  };
  const before = app.X.listenerCount('event');
  for (let i = 0; i < 10; i++) await cycle();
  assert.equal(app.X.listenerCount('event'), before);
});
