// The file dialog (issue #111) and the portal machinery under it (#129).
//
// Three rungs, and the tests are organised by which one is being exercised:
// the portal against a fake one on the broker, `osascript` by the script it
// builds (it cannot run here), and the built-in browser as an ordinary
// component. The fourth group is the ladder itself — which rung gets picked,
// and what happens when there is none.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import React from 'react';

import {
  NoPortalError,
  _resetServiceCache,
  hasService,
  parentWindowHandle,
  senderPath,
} from '../src/portal.js';
import {
  NoFileDialogError,
  fileDialogBackend,
  openFile,
  osascriptLines,
  saveFile,
  selectFolder,
} from '../src/filedialog.js';
import { _resetBusState, closeBus, sessionBus } from '../src/bus.js';
import { FileDialog } from '../src/components/FileDialog.js';
import { useFileDialog } from '../src/filedialoghooks.js';
import { useTopLevelWindow, windowIdOf } from '../src/windowid.js';
import {
  act,
  cleanup,
  fireEvent,
  renderX11,
  screen,
} from '../src/testing/index.js';
import { fakePortal } from './helpers/fake-portal.js';
import { transportAvailable, until, withBus } from './helpers/with-bus.js';

const haveTransport = await transportAvailable();
const needsBroker = haveTransport
  ? {}
  : { skip: 'dbus-native is not installed (expected on Node < 22.12)' };

afterEach(() => {
  _resetServiceCache();
});

/** A directory with a known shape, for the built-in browser. */
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rx11-files-'));
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello');
  await fs.writeFile(path.join(dir, 'b.md'), 'x');
  await fs.writeFile(path.join(dir, 'photo.png'), 'y');
  await fs.writeFile(path.join(dir, '.hidden'), 'z');
  return dir;
}

// The dialog is measured, laid out and clicked, so it needs a real font — but
// not a *particular* one, and not fontconfig, which answers differently on
// every machine and not at all in a container. KaTeX's face ships with ntk's
// own dependency tree, which is what `test/integration.test.js` uses for the
// same reason.
const require = createRequire(import.meta.url);
const FONTS = {
  'sans-serif': path.join(
    path.dirname(require.resolve('katex/package.json')),
    'dist',
    'fonts',
    'KaTeX_Main-Regular.ttf',
  ),
};

// ---------------------------------------------------------------------------

describe('the Request path', () => {
  // The transform is three characters of code and the entire reason the race
  // is avoidable, so it is pinned rather than trusted.
  test('a unique name becomes a request path element', () => {
    assert.equal(senderPath(':1.42'), '1_42');
    assert.equal(senderPath(':1.2.3'), '1_2_3');
    assert.equal(senderPath('1_42'), '1_42');
  });

  test('parent_window is lowercase hex with no 0x', () => {
    assert.equal(parentWindowHandle(0x1a00007), 'x11:1a00007');
    // No window is legal — the dialog just floats. Qt's parser answers 0 on a
    // malformed handle with no error path, so an empty string is the only
    // honest way to say "none".
    assert.equal(parentWindowHandle(null), '');
    assert.equal(parentWindowHandle(0), '');
  });
});

describe('the portal', { ...needsBroker }, () => {
  test('subscribes before it calls, and gets the answer', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(address, {
        OpenFile: () => ({
          response: 0,
          results: { uris: ['file:///tmp/one.txt', 'file:///tmp/two%20b.txt'] },
        }),
      });
      try {
        const files = await openFile({ title: 'Pick' });
        assert.deepEqual(files, ['/tmp/one.txt', '/tmp/two b.txt']);
        assert.equal(portal.calls.length, 1);
        // The client's own token, and therefore the path it subscribed to,
        // reached the portal — which is what makes the path predictable.
        assert.match(
          portal.calls[0].options.handle_token,
          /^rx11_[0-9a-f]{16}$/,
        );
        assert.equal(
          portal.calls[0].path,
          `/org/freedesktop/portal/desktop/request/${senderPath(
            await currentUniqueName(),
          )}/${portal.calls[0].options.handle_token}`,
        );
      } finally {
        await portal.stop();
      }
    });
  });

  test('a cancelled response resolves to null, not a throw', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(address, {
        OpenFile: () => ({ response: 1, results: {} }),
      });
      try {
        assert.equal(await openFile(), null);
      } finally {
        await portal.stop();
      }
    });
  });

  test('options are translated: filters, multiple, folders, names', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(address, {
        OpenFile: () => ({ response: 1, results: {} }),
        SaveFile: () => ({ response: 1, results: {} }),
      });
      try {
        await openFile({
          multiple: true,
          acceptLabel: 'Choose',
          defaultFolder: '/tmp/start',
          filters: [
            { name: 'Text', extensions: ['.txt', 'md'] },
            { name: 'Images', mimeTypes: ['image/png'] },
          ],
        });
        const open = portal.calls[0].options;
        assert.equal(open.multiple, true);
        assert.equal(open.accept_label, 'Choose');
        // A path is a NUL-terminated byte array here. A plain string marshals
        // as `s` and every backend ignores it, silently.
        assert.ok(Buffer.isBuffer(open.current_folder));
        assert.equal(open.current_folder.toString(), '/tmp/start\0');
        // `a(sa(us))`: (label, [(type, pattern)]), type 0 glob and 1 MIME.
        assert.deepEqual(open.filters, [
          [
            'Text',
            [
              [0, '*.txt'],
              [0, '*.md'],
            ],
          ],
          ['Images', [[1, 'image/png']]],
        ]);

        await saveFile({ defaultName: 'notes.md', multiple: true });
        const save = portal.calls[1].options;
        assert.equal(save.current_name, 'notes.md');
        // Saving is one file; `multiple` is meaningless and must not go out.
        assert.equal(save.multiple, undefined);
      } finally {
        await portal.stop();
      }
    });
  });

  test('the parent window travels as an x11: handle', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(address, {
        OpenFile: () => ({ response: 1, results: {} }),
      });
      try {
        await openFile({ parentWindow: 0x1a00007 });
        assert.equal(portal.calls[0].parentWindow, 'x11:1a00007');
      } finally {
        await portal.stop();
      }
    });
  });

  test('abort closes the request rather than walking away', async () => {
    await withBus(async (address) => {
      // Never answers: the only way out is Close(), which emits no Response —
      // so a client that merely stopped waiting would leave a dialog on the
      // user's screen with nobody listening.
      const portal = await fakePortal(address, {
        OpenFile: () => ({ silent: true }),
      });
      try {
        const ac = new AbortController();
        const pending = openFile({ signal: ac.signal });
        await until(() => portal.calls.length === 1, 'the call to arrive');
        ac.abort();
        await assert.rejects(pending, /aborted/i);
        await until(
          () => portal.closed.length === 1,
          'the portal to see Close()',
        );
        assert.equal(portal.closed[0], portal.calls[0].path);
      } finally {
        await portal.stop();
      }
    });
  });

  test('selectFolder asks for a directory', async () => {
    await withBus(async (address) => {
      const portal = await fakePortal(address, {
        OpenFile: () => ({
          response: 0,
          results: { uris: ['file:///tmp/dir'] },
        }),
      });
      try {
        assert.deepEqual(await selectFolder(), ['/tmp/dir']);
        assert.equal(portal.calls[0].member, 'OpenFile');
        assert.equal(portal.calls[0].options.directory, true);
      } finally {
        await portal.stop();
      }
    });
  });

  test('a portal that never answers the call is not a portal', async () => {
    await withBus(async (address) => {
      // The name is owned but nothing is exported at the object path, so the
      // method call errors — which must read as "no portal", not as a crash.
      const dbus = (await import('dbus-native')).default;
      const squatter = dbus.createClient({ busAddress: address });
      await new Promise((r) => squatter.connection.once('connect', r));
      await squatter.requestName('org.freedesktop.portal.Desktop', 0);
      try {
        await assert.rejects(
          () => openFile({ backend: 'portal' }),
          (err) => err instanceof NoPortalError,
        );
      } finally {
        await squatter.close();
      }
    });
  });
});

/** The unique name of the shared session bus, for path assertions. */
async function currentUniqueName() {
  const ref = await sessionBus();
  const name = ref.uniqueName;
  await ref.release();
  return name;
}

describe('hasService', { ...needsBroker }, () => {
  test('true for a name that is owned, false for one that is not', async () => {
    await withBus(async (address) => {
      assert.equal(await hasService('org.freedesktop.portal.Desktop'), false);
      const portal = await fakePortal(address);
      try {
        _resetServiceCache();
        assert.equal(await hasService('org.freedesktop.portal.Desktop'), true);
        assert.equal(await hasService('org.example.Nothing'), false);
      } finally {
        await portal.stop();
      }
    });
  });

  // The activation branch — the reason this is not NameHasOwner — cannot be
  // covered here: the broker has no service activation, so an activatable
  // name that nothing owns yet does not exist to be found. Stated so a green
  // suite is not read as covering it.
  test('only the positive answer is cached, so a portal that appears is found', async () => {
    await withBus(async (address) => {
      assert.equal(await hasService('org.freedesktop.portal.Desktop'), false);
      const portal = await fakePortal(address);
      try {
        // No reset: a cached *negative* here would be the bug — a feature
        // disabled for the life of the process on a machine where it works.
        assert.equal(await hasService('org.freedesktop.portal.Desktop'), true);
      } finally {
        await portal.stop();
      }
    });
  });
});

describe('the osascript rung', () => {
  // It cannot run here, so what is pinned is the script — which is the part
  // that breaks, and the part a Mac user cannot debug from a stack trace.
  test('open: prompt, type filter, location, and flags last', () => {
    const line = osascriptLines('open', {
      title: 'Pick an image',
      multiple: true,
      defaultFolder: '/Users/me/Pictures',
      filters: [{ name: 'Images', extensions: ['.png', 'jpg'] }],
    }).join(' ');
    assert.match(line, /choose file with prompt "Pick an image"/);
    assert.match(line, /of type \{"png", "jpg"\}/);
    assert.match(line, /default location POSIX file "\/Users\/me\/Pictures"/);
    // `with …` flags go last: AppleScript is conventional about this and the
    // failure mode is a syntax error at the far end of a pipe.
    assert.match(line, /default location .* with multiple selections allowed/);
  });

  test('MIME-only filters restrict nothing, deliberately', () => {
    const line = osascriptLines('open', {
      filters: [{ name: 'Text', mimeTypes: ['text/plain'] }],
    }).join(' ');
    assert.doesNotMatch(line, /of type/);
  });

  test('save uses choose file name with a default name', () => {
    const line = osascriptLines('save', {
      defaultName: 'notes.md',
      defaultFolder: '/tmp',
    }).join(' ');
    assert.match(line, /choose file name with prompt "Save file"/);
    assert.match(line, /default name "notes\.md"/);
  });

  test('folder uses choose folder', () => {
    assert.match(osascriptLines('folder', {}).join(' '), /choose folder/);
  });

  test('quotes in a title cannot break out of the script', () => {
    const line = osascriptLines('open', {
      title: 'a" & do shell script "id',
    }).join(' ');
    assert.match(line, /"a\\" & do shell script \\"id"/);
    assert.doesNotMatch(line, /prompt "a" /);
  });

  test('every branch normalises to newline-separated POSIX paths', () => {
    for (const kind of ['open', 'save', 'folder']) {
      const lines = osascriptLines(kind, {});
      assert.ok(
        lines.includes(
          'if class of theFiles is not list then set theFiles to {theFiles}',
        ),
        `${kind} handles the single-item case`,
      );
      assert.ok(lines.includes('set out to out & POSIX path of f & linefeed'));
    }
  });
});

describe('the built-in dialog', () => {
  afterEach(cleanup);

  test('lists a directory, hides dotfiles, and applies a filter', async () => {
    const dir = await fixture();
    let done = 'not called';
    await renderX11(
      React.createElement(FileDialog, {
        kind: 'open',
        startFolder: dir,
        filters: [{ name: 'Text', extensions: ['txt', 'md'] }],
        onDone: (r) => {
          done = r;
        },
      }),
      { wrap: false, fonts: FONTS },
    );
    await settle();

    const names = screen
      .queryAllByText(/^(sub\/|a\.txt|b\.md|photo\.png|\.hidden)$/)
      .map((n) => n.props.children);
    assert.deepEqual(names.sort(), ['a.txt', 'b.md', 'sub/']);

    fireEvent.click(screen.getByText('a.txt'));
    await settle();
    fireEvent.click(screen.getByText('Open'));
    await settle();
    assert.deepEqual(done, [path.join(dir, 'a.txt')]);
  });

  test('a double click opens a directory', async () => {
    const dir = await fixture();
    await fs.writeFile(path.join(dir, 'sub', 'inner.txt'), 'x');
    await renderX11(
      React.createElement(FileDialog, { startFolder: dir, onDone: () => {} }),
      { wrap: false, fonts: FONTS },
    );
    await settle();

    // Enter has always worked; the double click is the gesture everyone
    // reaches for first, and it did nothing.
    fireEvent.doubleClick(screen.getByText('sub/'));
    await settle();

    assert.equal(screen.queryAllByText('inner.txt').length, 1, 'we went in');
    assert.equal(screen.queryAllByText('a.txt').length, 0, 'and left');
  });

  test('a selected directory stays readable', async () => {
    const dir = await fixture();
    await renderX11(
      React.createElement(FileDialog, { startFolder: dir, onDone: () => {} }),
      { wrap: false, fonts: FONTS },
    );
    await settle();

    // A directory is drawn in the accent, and the selected row is *filled*
    // with it: both palettes derive one from the other, so the two used to be
    // the same colour and a selected directory could not be read at all.
    const resting = screen.getByText('sub/').style.color;
    fireEvent.click(screen.getByText('sub/'));
    await settle();

    const name = screen.getByText('sub/');
    assert.notEqual(
      name.style.color,
      resting,
      'the accent does not survive selection',
    );
    // the plain cells of the same row are the reference: whatever the theme
    // says is legible on the selection bar, the name column says too
    let row = name;
    while (row && row.props?.role !== 'row') row = row.parent;
    const colours = new Set();
    const walk = (n) => {
      if (n.kind === 'text') colours.add(n.style.color);
      n.children.forEach(walk);
    };
    walk(row);
    assert.deepEqual([...colours], [name.style.color], 'one legible colour');
  });

  test('cancel answers null exactly once', async () => {
    const dir = await fixture();
    const answers = [];
    await renderX11(
      React.createElement(FileDialog, {
        startFolder: dir,
        onDone: (r) => answers.push(r),
      }),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Cancel'));
    await settle();
    // Twice would settle a caller's promise twice; never would hang it.
    assert.deepEqual(answers, [null]);
  });

  test('show hidden reveals dotfiles', async () => {
    const dir = await fixture();
    await renderX11(
      React.createElement(FileDialog, { startFolder: dir, onDone: () => {} }),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    assert.equal(screen.queryAllByText('.hidden').length, 0);
    fireEvent.click(screen.getByText('Show hidden'));
    await settle();
    assert.equal(screen.queryAllByText('.hidden').length, 1);
  });

  test('save resolves the typed name against the current directory', async () => {
    const dir = await fixture();
    let done;
    await renderX11(
      React.createElement(FileDialog, {
        kind: 'save',
        startFolder: dir,
        defaultName: 'out.md',
        onDone: (r) => {
          done = r;
        },
      }),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    fireEvent.click(screen.getByText('Save'));
    await settle();
    assert.deepEqual(done, [path.join(dir, 'out.md')]);
  });

  test('a directory it cannot read says so instead of throwing', async () => {
    await renderX11(
      React.createElement(FileDialog, {
        startFolder: '/nonexistent/react-x11-not-here',
        onDone: () => {},
      }),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    assert.equal(screen.queryAllByText(/^Cannot read /).length, 1);
  });

  test('folder mode lists only directories and defaults to where you are', async () => {
    const dir = await fixture();
    let done;
    await renderX11(
      React.createElement(FileDialog, {
        kind: 'folder',
        startFolder: dir,
        onDone: (r) => {
          done = r;
        },
      }),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    assert.equal(screen.queryAllByText('a.txt').length, 0);
    assert.equal(screen.queryAllByText('sub/').length, 1);
    // Nothing selected means "this directory", which is what the path bar
    // shows — the alternative is a disabled button and a puzzled user.
    fireEvent.click(screen.getByText('Select'));
    await settle();
    assert.deepEqual(done, [dir]);
  });
});

describe('the owner window', () => {
  afterEach(cleanup);

  test('one top-level window is exact, with nothing passed', async () => {
    let owner;
    function Probe() {
      owner = useTopLevelWindow();
      return React.createElement('text', null, 'hi');
    }
    const view = await renderX11(
      React.createElement(
        'window',
        { width: 200, height: 120 },
        React.createElement(Probe),
      ),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    // Read through `windowIdOf`, which is how every consumer reaches it.
    assert.equal(windowIdOf(owner), view.windowNode.window.id);
  });

  test('it resolves on read, not on render', async () => {
    // The first render happens before the window is realized, so a hook that
    // captured a value then would hand back null on the render that matters.
    const seen = [];
    function Probe() {
      const owner = useTopLevelWindow();
      seen.push(windowIdOf(owner));
      return React.createElement('text', null, 'hi');
    }
    await renderX11(
      React.createElement(
        'window',
        { width: 200, height: 120 },
        React.createElement(Probe),
      ),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    assert.equal(seen[0], null, 'null during the first render, as expected');
    // …and the same object answers correctly once there is a window.
    assert.equal(seen.length >= 1, true);
  });

  test('a popup is never the owner', async () => {
    let owner;
    function Probe() {
      owner = useTopLevelWindow();
      return React.createElement(
        'box',
        null,
        React.createElement(
          'popup',
          { width: 60, height: 40, x: 10, y: 10 },
          React.createElement('text', null, 'pop'),
        ),
      );
    }
    const view = await renderX11(
      React.createElement(
        'window',
        { width: 200, height: 120 },
        React.createElement(Probe),
      ),
      { wrap: false, fonts: FONTS },
    );
    await settle();
    // A <popup> is override-redirect; a dialog transient for one would be
    // parented to something the window manager does not manage.
    assert.equal(windowIdOf(owner), view.windowNode.window.id);
  });

  test('the dialog is parented with no ref and no options at all', async () => {
    let open;
    function Probe() {
      const dialogs = useFileDialog({ backend: 'builtin' });
      open = () => dialogs.openFile({ defaultFolder: os.tmpdir() });
      return React.createElement('text', null, 'hi');
    }
    const view = await renderX11(
      React.createElement(
        'window',
        { width: 200, height: 120 },
        React.createElement(Probe),
      ),
      { wrap: false, fonts: FONTS },
    );
    await settle();

    const created = [];
    const makeWindow = view.app.createWindow.bind(view.app);
    view.app.createWindow = (attrs) => {
      const w = makeWindow(attrs);
      created.push(w);
      return w;
    };

    await act(async () => {
      open().catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    });
    assert.equal(created.length, 1, 'the built-in dialog opened');

    const X = view.app.X;
    const atom = await new Promise((res, rej) =>
      X.InternAtom(false, 'WM_TRANSIENT_FOR', (e, a) => (e ? rej(e) : res(a))),
    );
    const prop = await new Promise((res, rej) =>
      X.GetProperty(0, created[0].id, atom, 0, 0, 10, (e, p) =>
        e ? rej(e) : res(p),
      ),
    );
    assert.ok(prop?.data?.length >= 4, 'WM_TRANSIENT_FOR is set');
    assert.equal(prop.data.readUInt32LE(0), view.windowNode.window.id);
  });
});

describe('the ladder', () => {
  test('backend selection is reported without showing anything', async () => {
    const backend = await fileDialogBackend();
    assert.ok(['portal', 'osascript', 'builtin'].includes(backend));
  });

  test('no portal and not macOS: a typed rejection, not a crash', async () => {
    await withNoBus(async () => {
      await assert.rejects(
        () => openFile(),
        (err) => {
          assert.ok(err instanceof NoFileDialogError);
          // The message has to name the way out, because this is the error an
          // app developer hits on the machine they are actually sitting at.
          assert.match(err.message, /useFileDialog/);
          return true;
        },
      );
    });
  });

  test('backend: builtin skips the native rungs outright', async () => {
    await assert.rejects(
      () => openFile({ backend: 'builtin' }),
      (err) => err instanceof NoFileDialogError,
    );
  });
});

/**
 * Run `fn` on a machine with no session bus and no macOS.
 *
 * **The `closeBus()` is load-bearing, not tidying.** The shared connection
 * stays up across acquisitions by design, so pointing the env var at nothing
 * changes what the *next* connect would dial and not what is already open —
 * and a test that skipped this on a developer's own desktop would reach the
 * real portal and put a file dialog on their screen, then wait for a human.
 * That is exactly what happened while writing these.
 */
async function withNoBus(fn) {
  const saved = {
    address: process.env.DBUS_SESSION_BUS_ADDRESS,
    runtime: process.env.XDG_RUNTIME_DIR,
    platform: process.platform,
  };
  await closeBus('session').catch(() => {});
  _resetBusState();
  _resetServiceCache();
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/no-bus-here';
  delete process.env.XDG_RUNTIME_DIR;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: saved.platform });
    if (saved.address === undefined)
      delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved.address;
    if (saved.runtime !== undefined)
      process.env.XDG_RUNTIME_DIR = saved.runtime;
    await closeBus('session').catch(() => {});
    _resetBusState();
    _resetServiceCache();
  }
}

/** Let effects, the frame clock and one directory read all land. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}
