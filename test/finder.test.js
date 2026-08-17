// examples/finder.jsx, over a filesystem that does not exist.
//
// Everything the app touches outside itself — `readdir`, `stat`, the spawn
// that starts a terminal — goes through one backend object, so these tests
// browse a tree made of literals and assert that an `xterm` *would* have been
// started with the right window id, without an `xterm` anywhere.
//
// The one claim worth testing hardest is the windowing: a directory of 50,000
// entries must not become 50,000 nodes. That is the difference between an
// example and a toy, and it is invisible until the number is large.
import { test, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  renderX11,
  cleanup,
  screen,
  waitFor,
  userEvent,
  within,
} from '../src/testing/index.js';

process.env.REACT_X11_NO_AUTORUN = '1';

const { FinderPanel, listingOf } = await import('../examples/finder.jsx');

afterEach(cleanup);

const h = React.createElement;

const entry = (name, dir = false) => ({
  name,
  dir,
  link: false,
  path: `/home/me/${name}`,
});

/** A filesystem of literals. `fail` maps a path to the errno it refuses with. */
function fakeBackend(tree, { fail = {} } = {}) {
  const spawned = [];
  return {
    spawned,
    home: () => '/home/me',
    async read(dir) {
      if (fail[dir]) {
        const err = new Error(fail[dir]);
        err.code = fail[dir];
        throw err;
      }
      const rows = tree[dir];
      if (!rows) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return rows;
    },
    async follows() {
      return false;
    },
    spawnTerminal(windowId, dir) {
      spawned.push({ windowId, dir });
      return { pid: 1234 };
    },
  };
}

// Places and files are both `role="option"` lists — correctly — so every row
// query says which list it means.
const files = () => within(screen.getByTestName('listing'));
const row = (name) => files().getByRole('option', { name });
const countRows = () => files().queryAllByRole('option').length;

describe('examples/finder', () => {
  test('a listing of 50,000 entries renders a screenful', async () => {
    const many = Array.from({ length: 50_000 }, (_, i) =>
      entry(`file-${String(i).padStart(5, '0')}`),
    );
    const backend = fakeBackend({ '/home/me': many });

    await renderX11(h(FinderPanel, { backend }), { width: 820, height: 560 });
    await waitFor(() => assert.ok(countRows() > 0, 'nothing rendered'));

    // The window is 560 tall and a row is 22, so a screenful is ~25 plus the
    // overscan. The assertion is deliberately loose about the exact number
    // and hard about the order of magnitude: what must never happen is the
    // whole directory becoming nodes.
    const rows = countRows();
    assert.ok(
      rows > 5 && rows < 120,
      `expected a screenful of rows, rendered ${rows} of 50,000`,
    );

    // …and the ones rendered are the top of the listing, not a random slice.
    screen.getByText('file-00000');
  });

  test('the places and the breadcrumbs both navigate', async () => {
    const backend = fakeBackend({
      '/home/me': [entry('Downloads', true), entry('notes.txt')],
      '/home/me/Downloads': [entry('a.iso')],
      '/home': [entry('me', true)],
    });

    await renderX11(h(FinderPanel, { backend }), { width: 820, height: 560 });
    await waitFor(() => screen.getByText('notes.txt'));

    await userEvent.doubleClick(row('Downloads'));
    await waitFor(() => screen.getByText('a.iso'));

    // `exact` because the crumbs are `/ › home › me › Downloads` and "me" is
    // a substring of "home" — role names match the node's text.
    await userEvent.click(
      screen.getByRole('link', { name: 'me', exact: true }),
    );
    await waitFor(() => screen.getByText('notes.txt'));
  });

  test('a directory it may not read says so, and the app keeps its shape', async () => {
    const backend = fakeBackend(
      { '/home/me': [entry('private', true)] },
      { fail: { '/home/me/private': 'EACCES' } },
    );

    await renderX11(h(FinderPanel, { backend }), { width: 820, height: 560 });
    await waitFor(() => screen.getByText('private'));

    await userEvent.doubleClick(row('private'));

    // Resolved rather than thrown: no error boundary, no blank window — the
    // reason is rendered where the files would have been, and the sidebar and
    // the breadcrumbs are still there to leave by.
    await waitFor(() => screen.getByText('not yours to read'));
    within(screen.getByTestName('places')).getByRole('option', {
      name: 'Home',
    });
  });

  test('a row offers its path as text/uri-list, lazily', async () => {
    const backend = fakeBackend({ '/home/me': [entry('notes.txt')] });
    await renderX11(h(FinderPanel, { backend }), { width: 820, height: 560 });
    await waitFor(() => screen.getByText('notes.txt'));

    const offered = row('notes.txt').props.dragData;
    assert.deepEqual(Object.keys(offered), ['text/uri-list']);

    // A **thunk**, so a drag that never leaves the app costs nothing to
    // start. Calling it is what a drop — or crossing the window edge — does.
    assert.equal(typeof offered['text/uri-list'], 'function');
    assert.equal(offered['text/uri-list'](), 'file:///home/me/notes.txt\r\n');
  });

  test('the terminal pane is spawned into the id the pane hands out', async () => {
    const backend = fakeBackend({ '/home/me': [entry('notes.txt')] });
    await renderX11(h(FinderPanel, { backend }), { width: 820, height: 560 });
    await waitFor(() => screen.getByText('notes.txt'));

    // Ctrl+T is the application's chord, which is the thing an embedded
    // terminal must not eat — docs/embedding.md.
    await userEvent.click(row('notes.txt'));
    await userEvent.key(0x74, { modifiers: ['Control'] }); // Ctrl+T

    await waitFor(() =>
      assert.equal(backend.spawned.length, 1, 'no terminal was started'),
    );
    // The adopt path: no `windowId` prop, so the pane hands out its own and
    // the program is started into that. A spawn with no id would be a
    // terminal drawing on the root window.
    assert.ok(
      Number.isInteger(backend.spawned[0].windowId) &&
        backend.spawned[0].windowId > 0,
      `spawned into ${backend.spawned[0].windowId}`,
    );
  });

  test('a listing is cached per backend, not globally', async () => {
    // The mistake chat's history made before it was keyed by transport: two
    // backends sharing one cache means a test — or a second window — sees the
    // other's answer.
    const a = fakeBackend({ '/home/me': [entry('from-a')] });
    const b = fakeBackend({ '/home/me': [entry('from-b')] });
    const [ra, rb] = await Promise.all([
      listingOf(a, '/home/me'),
      listingOf(b, '/home/me'),
    ]);
    assert.equal(ra.entries[0].name, 'from-a');
    assert.equal(rb.entries[0].name, 'from-b');
  });
});
