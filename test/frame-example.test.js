// examples/frame.jsx, kept honest headlessly: the pane runs behind the
// example's transport seam (a loopback into runFrameChild), and the same
// module runs inline — the comparison the example exists to make. The
// interesting number both ways is `onStats`: the pane really painted, and
// it says which process it painted in.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';
import xserver from 'x11/lib/xserver/index.js';
import { createClient } from 'ntk';

import { createRoot } from '../src/index.js';
import { loopbackFrameFactory } from './helpers/frame-loopback.js';

// before the example is imported: its autorun block connects to a real
// display otherwise, which is the example working as designed
process.env.REACT_X11_NO_AUTORUN = '1';

const { App } = await import('../examples/frame.jsx');

const h = React.createElement;

async function headlessPair() {
  const server = xserver.createServer({ width: 1280, height: 800 });
  // no fontSource: the example is full of text, so fonts come from
  // fontconfig, the way the monitor and chat example tests already do
  const connect = async () => {
    const [serverEnd, clientEnd] = xserver.createStreamPair();
    server.addClientStream(serverEnd);
    return createClient({ stream: clientEnd, onXError: () => {} });
  };
  return { server, app: await connect(), other: await connect() };
}

const render = (element, x11Root) =>
  new Promise((resolve) => x11Root.render(element, resolve));

const settle = (app) =>
  new Promise((resolve) => app.X.GetInputFocus(() => setImmediate(resolve)));

async function until(app, predicate, what, { tries = 600, delay = 3 } = {}) {
  for (let i = 0; i < tries; i++) {
    if (await predicate()) return;
    await settle(app);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function teardown(x11Root, app, other) {
  await x11Root.unmount().catch(() => {});
  await settle(app);
  await app.close();
  await other.close();
}

test('the example runs its pane behind the seam, and the stats flow back', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  const factory = loopbackFrameFactory({ childApp: other });
  const stats = [];
  try {
    await render(
      h(App, { frameTransport: factory, onStats: (s) => stats.push(s) }),
      x11Root,
    );
    await until(app, () => stats.length >= 1, 'the pane stats');
    assert.equal(typeof stats[0].ms, 'number');
    assert.ok(stats[0].pixels > 0);
    assert.equal(factory.sessions.length, 1);
  } finally {
    await teardown(x11Root, app, other);
  }
});

test('the same module runs inline', async () => {
  const { app, other } = await headlessPair();
  const x11Root = await createRoot({ app });
  const stats = [];
  try {
    await render(
      h(App, { initialFramed: false, onStats: (s) => stats.push(s) }),
      x11Root,
    );
    await until(app, () => stats.length >= 1, 'the inline stats');
    // inline means this process: the pane's own pid is the proof
    assert.equal(stats[0].pid, process.pid);
  } finally {
    await teardown(x11Root, app, other);
  }
});
