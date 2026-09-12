// <foreign> on the Cocoa backend (src/foreignnodes.js), over the fake bridge.
//
// macOS has no cross-process window embedding, and the element has to say so
// rather than half-work. It used to half-work (issue #531): the CocoaApp has
// an X stub and a `createWindow` that takes a parent, which was enough for a
// socket to be built around a child GL surface whose `id` is undefined, and
// for `onReady({ windowId: undefined })` to go out — which a caller spawns
// `xterm -into undefined` with. The mock-backend half of the same contract is
// at the end of test/foreign.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { createRoot, useSupports } from '../src/index.js';
import { fakeCocoaApp, tick } from './helpers/cocoa-bridge.js';

const h = React.createElement;

test('<foreign> refuses on Cocoa rather than hand out an id it does not have', async () => {
  const { app } = fakeCocoaApp();
  // every window asked for with a parent — the container a socket builds,
  // which here was a child surface rather than an X window
  const children = [];
  const createWindow = app.createWindow.bind(app);
  app.createWindow = (attrs) => {
    if (attrs?.parent) children.push(attrs);
    return createWindow(attrs);
  };
  const root = await createRoot({ app });
  const ready = [];
  const errors = [];
  let embedding = null;
  function Pane() {
    embedding = useSupports('embedding');
    return h('foreign', {
      style: { flexGrow: 1 },
      onReady: (info) => ready.push(info),
      onError: (err) => errors.push(err),
    });
  }
  try {
    root.render(h('window', { width: 200, height: 120 }, h(Pane)));
    await tick();
    await tick();
    assert.equal(embedding, false);
    assert.equal(
      ready.length,
      0,
      `onReady was called with windowId ${ready.map((r) => r.windowId)}`,
    );
    assert.equal(errors.length, 1, 'one onError');
    assert.match(errors[0].message, /<foreign> needs the X11 backend/);
    assert.equal(children.length, 0, 'no container was created');
  } finally {
    await root.unmount();
  }
});
