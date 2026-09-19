// The Windows taskbar's surfaces, and the seam that makes them safe to use
// from code that also runs somewhere else.
//
// The seam is one rule: **the backend installs a method, and its presence is
// the capability.** The three surfaces are reported as features of the
// *launcher* — the same rung as the badge and the progress bar, because all
// of them hang off the one icon the desktop shows for this app — so a
// component asks `useDesktopCapability('launcher')` and branches on
// `features.thumbnailToolbar` rather than on the platform.
//
// Two things are checked here. The first is that the probe names the
// mechanism honestly, which it did not: every backend installs the same
// method names on purpose (that is what makes `useTray` and `useBadge` one
// hook each), so a probe that read `setDockBadge` as "this is AppKit"
// reported the Windows taskbar as `backend: 'cocoa'` — with `progress: false`
// beside a working progress bar. The second is that the hooks are *inert*
// where the surfaces do not exist, without anything in the app or in the hook
// knowing which platform it is on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';

import { capabilityNow } from '../src/capabilities.js';
import {
  noteRecentDocument,
  useJumpList,
  useRecentDocument,
  useThumbnailToolbar,
} from '../src/index.js';
import { renderX11 } from '../src/testing/index.js';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const h = React.createElement;

/** The methods the win32 backend installs, and the mechanisms it declares. */
const taskbarApp = () => ({
  shellMechanisms: { tray: 'shellnotifyicon', launcher: 'taskbar' },
  createStatusItem() {},
  setDockBadge() {},
  setTaskbarProgress() {},
  thumbnailToolbar() {},
  jumpList() {},
  noteRecentDocument() {},
});

/** What AppKit installs: the same two names, and no mechanism to declare. */
const dockApp = () => ({
  createStatusItem() {},
  setDockBadge() {},
  setDockMenu() {},
});

test('the mechanism is named by the backend, not guessed from a method', () => {
  const taskbar = capabilityNow('launcher', { app: taskbarApp() });
  const dock = capabilityNow('launcher', { app: dockApp() });

  // The regression: both apps have `setDockBadge`, so the mechanism cannot be
  // read off it. Before this was declared, the first of these said 'cocoa'.
  assert.equal(taskbar.backend, 'taskbar');
  assert.equal(dock.backend, 'cocoa');

  // And the feature maps are the two desktops' own, not one copied onto both.
  assert.equal(
    taskbar.features.progress,
    true,
    'the taskbar has a progress bar',
  );
  assert.equal(dock.features.progress, false, 'NSDockTile has none');

  // The tray is the same story: SF Symbols and click modifiers are AppKit's.
  const tray = capabilityNow('tray', { app: taskbarApp() });
  assert.equal(tray.backend, 'shellnotifyicon');
  assert.equal(tray.features.iconName, false);
  assert.equal(tray.features.clickModifiers, false);
  assert.equal(capabilityNow('tray', { app: dockApp() }).backend, 'cocoa');
});

test('the three surfaces are launcher features, and follow the methods', () => {
  const full = capabilityNow('launcher', { app: taskbarApp() });
  assert.deepEqual(
    {
      tasks: full.features.tasks,
      thumbnailToolbar: full.features.thumbnailToolbar,
      recentDocuments: full.features.recentDocuments,
    },
    { tasks: true, thumbnailToolbar: true, recentDocuments: true },
  );

  // The probe reads the same methods the hooks call, which is what keeps the
  // prediction and the hook from disagreeing: take one away and it says so.
  const partial = taskbarApp();
  delete partial.thumbnailToolbar;
  assert.equal(
    capabilityNow('launcher', { app: partial }).features.thumbnailToolbar,
    false,
  );

  // A Dock reports them false rather than leaving them out, so a component
  // reading `features.tasks` gets an answer everywhere.
  const dock = capabilityNow('launcher', { app: dockApp() });
  assert.equal(dock.features.tasks, false);
  assert.equal(dock.features.thumbnailToolbar, false);
});

test('a backend without them mounts the hooks and nothing happens', async () => {
  const calls = [];

  function App() {
    useThumbnailToolbar(
      [
        { id: 'prev', tooltip: 'Previous' },
        { id: 'play', tooltip: 'Play' },
      ],
      (id) => calls.push(id),
    );
    useJumpList([{ title: 'New window', arguments: '--new' }]);
    useRecentDocument('C:/tmp/a.txt');
    return h('box', null);
  }

  const { app, unmount } = await renderX11(h('window', null, h(App)), {
    backend: 'mock',
  });
  try {
    await nextTurn();
    // The point of the seam: three hooks mounted, nothing reached the app.
    assert.equal(typeof app.thumbnailToolbar, 'undefined');
    assert.equal(typeof app.jumpList, 'undefined');
    assert.equal(typeof app.noteRecentDocument, 'undefined');
    assert.equal(calls.length, 0);
  } finally {
    // Unmounting runs the cleanups, which must also do nothing rather than
    // call through a method that is not there.
    await unmount();
  }
});

test('the imperative form answers false rather than throwing', async () => {
  const { app, unmount } = await renderX11(h('window', null), {
    backend: 'mock',
  });
  try {
    assert.equal(noteRecentDocument('C:/tmp/a.txt', { app }), false);
    assert.equal(noteRecentDocument(null, { app }), false);

    const sent = [];
    app.noteRecentDocument = (path) => sent.push(path);
    assert.equal(noteRecentDocument('C:/tmp/b.txt', { app }), true);
    assert.deepEqual(sent, ['C:/tmp/b.txt']);
  } finally {
    await unmount();
  }
});
