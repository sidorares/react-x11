// `<Activity mode="hidden">` and a `<Suspense>` boundary showing its
// fallback hide a subtree through the reconciler's `hideInstance`, which
// React calls *after* it has inserted that subtree. For a toplevel
// `<window>` that used to mean a MapWindow and an UnmapWindow back to back
// in one commit — a pair that is only safe when nothing redirects the map
// (issue #201).
//
// So the configuration that matters is the one with a window manager on the
// other end, and node-x11's in-process server can hold substructure redirect
// (x11 >= 3.2.0), the same setup test/wm.test.js uses: two connections to
// one server, one of them playing the window manager.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import xserver from 'x11/lib/xserver/index.js';
import { createClient, StaticFontSource } from 'ntk';

import { createRoot } from '../src/index.js';

const SCREEN = { width: 800, height: 600 };
const IS_UNMAPPED = 0;
const IS_VIEWABLE = 2;

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
 * The smallest thing that counts as a window manager: hold
 * SubstructureRedirect on the root and honour the MapRequests that arrive
 * because of it. That redirect is the whole story — it is what turns a
 * client's MapWindow into a request somebody else services later.
 */
async function startWM(app) {
  const { X } = app;
  const root = X.display.screen[0].root;
  const seen = { mapRequests: 0 };
  await new Promise((resolve, reject) =>
    X.ChangeWindowAttributes(
      root,
      {
        eventMask:
          X.eventMask.SubstructureRedirect | X.eventMask.SubstructureNotify,
      },
      (err) => (err ? reject(err) : resolve()),
    ),
  );
  X.on('event', (ev) => {
    if (ev.name !== 'MapRequest') return;
    seen.mapRequests++;
    X.MapWindow(ev.wid);
  });
  await settle(app);
  return seen;
}

const rootChildren = (app) =>
  new Promise((resolve, reject) =>
    app.X.QueryTree(app.X.display.screen[0].root, (err, tree) =>
      err ? reject(err) : resolve(tree.children),
    ),
  );

const mapStateOf = (app, wid) =>
  new Promise((resolve, reject) =>
    app.X.GetWindowAttributes(wid, (err, attrs) =>
      err ? reject(err) : resolve(attrs.mapState),
    ),
  );

/**
 * React first, then both connections. A hidden `<Activity>` mounts its
 * children at a deferred lane, so the commit under test is not the one
 * `render()` returns from — `act` is what drains it.
 */
async function flush(apps, fn) {
  const previous = globalThis.IS_REACT_ACT_ENVIRONMENT;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await React.act(async () => {
      await fn?.();
    });
    for (let round = 0; round < 3; round++) {
      await React.act(async () => {
        for (const app of apps) await settle(app);
      });
    }
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

const activity = (mode) =>
  React.createElement(
    React.Activity,
    { mode },
    React.createElement(
      'window',
      { width: 200, height: 120, title: 'activity' },
      React.createElement('box', {
        style: { width: 50, height: 20, backgroundColor: '#f00' },
      }),
    ),
  );

/** Mount a hidden `<Activity>` around a toplevel `<window>`, with or
 * without a window manager, and hand back the pieces to assert on. */
async function mountHidden({ wm }) {
  const { wmApp, clientApp } = await headlessPair();
  const seen = wm ? await startWM(wmApp) : { mapRequests: 0 };
  const root = await createRoot({ app: clientApp });
  const apps = [clientApp, wmApp];

  await flush(apps, () => {
    root.render(activity('hidden'));
  });

  const wid = (await rootChildren(clientApp)).at(-1) ?? null;
  assert.ok(wid != null, 'the <window> was created');

  const done = async () => {
    await root.unmount();
    await wmApp.close();
    await clientApp.close();
  };
  return { root, apps, clientApp, wid, seen, done };
}

test('a <window> hidden by <Activity> is never mapped, with no window manager', async () => {
  const { clientApp, wid, seen, done } = await mountHidden({ wm: false });

  assert.equal(await mapStateOf(clientApp, wid), IS_UNMAPPED);
  assert.equal(seen.mapRequests, 0);

  await done();
});

test('a <window> hidden by <Activity> is never mapped under a window manager', async () => {
  const { clientApp, wid, seen, done } = await mountHidden({ wm: true });

  // The regression: the map used to go out during the commit and come back
  // as a MapRequest, so the window manager mapped the window for good — the
  // UnmapWindow that followed had already been discarded, having landed on
  // a window the server had not mapped.
  assert.equal(seen.mapRequests, 0, 'nothing was ever asked to be mapped');
  assert.equal(
    await mapStateOf(clientApp, wid),
    IS_UNMAPPED,
    'the hidden window is not on screen',
  );

  await done();
});

test('revealing the <Activity> maps the window, and hiding it again unmaps it', async () => {
  const { root, apps, clientApp, wid, seen, done } = await mountHidden({
    wm: true,
  });

  // its own premise: nothing has been mapped yet, so the count below is
  // this reveal's and not the mount's
  assert.equal(seen.mapRequests, 0);

  await flush(apps, () => {
    root.render(activity('visible'));
  });
  assert.equal(seen.mapRequests, 1, 'now it asks');
  assert.equal(await mapStateOf(clientApp, wid), IS_VIEWABLE);

  // and the ordinary path back: unmapping a window the server really has
  // mapped is never redirected, so this half always worked
  await flush(apps, () => {
    root.render(activity('hidden'));
  });
  assert.equal(await mapStateOf(clientApp, wid), IS_UNMAPPED);

  await done();
});
