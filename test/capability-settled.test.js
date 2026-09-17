// `settled` on `useTray()` and `useDesktopCapability()` (#594): whether
// `available` is an answer yet.
//
// On the freedesktop tray `available` starts false and settles a bus round
// trip later, so an app whose whole UI is its tray item, with a window as the
// fallback, could not tell "no tray" from "not asked yet" — and following the
// render-the-fallback-first rule flashed a window up and away on every start.
// What is pinned: the first frame is pending where an answer needs asking and
// settled where it does not — the Cocoa status item and Dock tile, and no
// item at all — and it settles either way, a "no" included.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { useDesktopCapability } from '../src/desktopcapabilityhooks.js';
import { useTray } from '../src/trayhooks.js';
import { createMockApp } from './helpers/mock-app.js';
import { withNoBus } from './helpers/with-bus.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

/** Every state `hook()` returned, render by render, in a window of `app`. */
async function renders(hook, app = createMockApp()) {
  const seen = [];
  const Probe = () => {
    seen.push(hook());
    return null;
  };
  const root = await createRoot({ app });
  roots.push(root);
  root.render(h('window', { width: 100, height: 100 }, h(Probe)));
  return { seen, app, root };
}

/** A mock app with a status item and a Dock tile of its own, as the Cocoa
 *  app has — answers that need nothing asked. */
function nativeApp() {
  const app = createMockApp();
  app.createStatusItem = () => ({ update() {}, remove() {} });
  app.setDockBadge = () => {};
  return app;
}

test('a capability is pending until the probe answers, and settled by a "no"', async () => {
  await withNoBus(async () => {
    const { seen } = await renders(() => useDesktopCapability('tray'));
    assert.equal(seen[0].settled, false, 'the first frame has no answer');
    assert.equal(seen[0].available, false);
    for (let i = 0; i < 5 && !seen.at(-1).settled; i++) await tick();
    assert.equal(seen.at(-1).settled, true, 'and then it does');
    assert.equal(seen.at(-1).available, false, 'no bus is a real "no"');
  });
});

test('where nothing needs asking, the first frame is settled', async () => {
  const tray = await renders(() => useDesktopCapability('tray'), nativeApp());
  assert.equal(tray.seen[0].settled, true);
  assert.equal(tray.seen[0].available, true);
  assert.equal(tray.seen[0].backend, 'cocoa');

  const launcher = await renders(
    () => useDesktopCapability('launcher'),
    nativeApp(),
  );
  assert.equal(launcher.seen[0].settled, true);
  assert.equal(launcher.seen[0].backend, 'cocoa');
  await tick();
  await tick();
  assert.ok(
    launcher.seen.at(-1) === launcher.seen[0] ||
      launcher.seen.at(-1).settled === true,
    'the probe that follows agrees and stays settled',
  );
});

test("useTray on the platform's own status item is settled at once", async () => {
  const { seen } = await renders(() => useTray({ icon: 'bell' }), nativeApp());
  assert.equal(seen[0].settled, true);
  assert.equal(seen[0].available, true);
});

test('useTray on the freedesktop rung settles once the host answers — or nothing does', async () => {
  await withNoBus(async () => {
    const { seen } = await renders(() => useTray({ icon: 'bell' }));
    assert.equal(seen[0].settled, false, 'the fallback can wait');
    for (let i = 0; i < 10 && !seen.at(-1).settled; i++) await tick();
    assert.equal(seen.at(-1).settled, true);
    assert.equal(seen.at(-1).available, false, 'no tray, and it is sure');
  });
});

test('no item at all has nothing to wait for', async () => {
  const { seen } = await renders(() => useTray(null));
  assert.equal(seen[0].settled, true);
  assert.equal(seen[0].available, false);
});
