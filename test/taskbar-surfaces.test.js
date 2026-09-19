// The Windows taskbar's surfaces, and the seam that makes them safe to use
// from code that also runs somewhere else.
//
// The seam is one rule: **the backend installs a method, and its presence is
// the capability.** `useSupports('thumbnailToolbar')` asks whether the app has
// that method; a backend that has the feature puts it there and every other
// one does not. So the interesting test is not that the hooks work where the
// feature exists — it is that they are *inert* where it does not, without
// anything in the app or in the hook knowing which platform it is on.
//
// That is what is checked here, against the mock backend: the capability
// reads false, the hooks mount and unmount without touching anything, and the
// imperative form says it did nothing rather than throwing.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import React from 'react';

import {
  noteRecentDocument,
  useJumpList,
  useRecentDocument,
  useSupports,
  useThumbnailToolbar,
} from '../src/index.js';
import { renderX11 } from '../src/testing/index.js';

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

const h = React.createElement;

/** Every capability this file is about, read in one render. */
function Reads({ onRead }) {
  const thumbnailToolbar = useSupports('thumbnailToolbar');
  const jumpList = useSupports('jumpList');
  const recentDocuments = useSupports('recentDocuments');
  onRead({ thumbnailToolbar, jumpList, recentDocuments });
  return h('box', null);
}

test('a backend without them reports so, and the hooks do nothing', async () => {
  const reads = [];
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
    return h(Reads, { onRead: (r) => reads.push(r) });
  }

  const { app, unmount } = await renderX11(h('window', null, h(App)), {
    backend: 'mock',
  });
  try {
    await nextTurn();
    const last = reads[reads.length - 1];
    assert.deepEqual(
      last,
      { thumbnailToolbar: false, jumpList: false, recentDocuments: false },
      'a backend with none of these said it had one',
    );
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
  } finally {
    await unmount();
  }
});

test('a backend that has them is reported as having them', async () => {
  // The other half of the same rule, with the methods put on by hand: the
  // capability follows the method, so this is the win32 backend's behaviour
  // without needing Windows to run it.
  const sent = [];
  const { app, unmount } = await renderX11(h('window', null), {
    backend: 'mock',
  });
  try {
    app.thumbnailToolbar = (id, buttons) => sent.push(['toolbar', id, buttons]);
    app.jumpList = (tasks) => sent.push(['jumpList', tasks]);
    app.noteRecentDocument = (path) => sent.push(['recent', path]);

    const reads = [];
    const { unmount: unmount2 } = await renderX11(
      h('window', null, h(Reads, { onRead: (r) => reads.push(r) })),
      { backend: 'mock', app },
    );
    await nextTurn();
    assert.deepEqual(reads[reads.length - 1], {
      thumbnailToolbar: true,
      jumpList: true,
      recentDocuments: true,
    });
    assert.equal(noteRecentDocument('C:/tmp/b.txt', { app }), true);
    assert.deepEqual(sent.at(-1), ['recent', 'C:/tmp/b.txt']);
    await unmount2();
  } finally {
    await unmount();
  }
});
