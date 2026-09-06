// Native file panels on the cocoa backend (src/cocoa/filepanels.js,
// @windowkit/appkit >= 0.5): the top rung of the file-dialog ladder.
//
// Three layers, headless, over a recording fake bridge:
//
//   1. the **translation** — react-x11's options as the bridge's panel
//      spec, a pure function with the OS type lookup injected;
//   2. the **panel** — what `CocoaFilePanels.show` makes of the bridge's
//      answers: paths, a cancel, an abort;
//   3. the **ladder** — that `openFile` and `useFileDialog` reach this rung
//      through the window they name and never by naming a backend, that the
//      sheet is on that window, and that `fileDialogBackend()` says so.
//
// A real panel opening on glass is not something this file can show; the
// bridge's own CI presents one and cancels it from JS.
import assert from 'node:assert';
import { afterEach, describe, test } from 'node:test';
import React from 'react';

import { createRoot } from '../src/index.js';
import { CocoaApp } from '../src/cocoa/app.js';
import { CocoaFilePanels, panelSpec } from '../src/cocoa/filepanels.js';
import {
  NoFileDialogError,
  fileDialogBackend,
  openFile,
  saveFile,
  selectFolder,
} from '../src/filedialog.js';
import { useFileDialog } from '../src/filedialoghooks.js';
import { PortalCancelledError } from '../src/portal.js';
import { setScaleForTests } from '../src/scale.js';
import { setScreensForTests } from '../src/screens.js';
import { setCompositingForTests } from '../src/compositing.js';

const h = React.createElement;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The OS type database, as far as these tests need one. */
const TYPES = {
  'extension:png': 'public.png',
  'extension:jpg': 'public.jpeg',
  'extension:md': 'net.daringfireball.markdown',
  'mime:application/json': 'public.json',
  'mime:image/png': 'public.png',
};
const contentTypeFor = (q) =>
  TYPES[q.extension ? `extension:${q.extension}` : `mime:${q.mime}`] ?? null;

/**
 * A bridge shaped like @windowkit/appkit's, with panels: the spec of every
 * panel is recorded, and `answer` decides what the panel's callback says —
 * asynchronously with a window (a sheet), synchronously without (app-modal),
 * the way the real one does.
 */
function fakeNative({ answer = () => null } = {}) {
  let seq = 0;
  const base = {
    panels: [],
    cancelled: [],
    contentTypeFor,
    openPanel(spec, cb) {
      const handle = { id: ++seq, spec, cb };
      base.panels.push(handle);
      const result = answer('open', spec);
      if (spec.window != null) setImmediate(() => handle.cb(result));
      else cb(result);
      return handle;
    },
    savePanel(spec, cb) {
      const handle = { id: ++seq, spec, cb };
      base.panels.push(handle);
      const result = answer('save', spec);
      if (spec.window != null) setImmediate(() => handle.cb(result));
      else cb(result);
      return handle;
    },
    cancelPanel(handle) {
      base.cancelled.push(handle.id);
      handle.cb(null);
      return true;
    },
    setBackendEventCallback() {},
    initApp() {},
    listScreens: () => [
      {
        x: 0,
        y: 0,
        width: 1440,
        height: 900,
        scale: 2,
        fps: 60,
        visible: { x: 0, y: 0, width: 1440, height: 875 },
        primary: true,
      },
    ],
    createWindow2: (o) => ({ id: ++seq, options: { ...o } }),
    windowNumber: (handle) => handle.id,
    windowRootLayer: (handle) => ({ root: handle.id }),
    getWindowFrame: (handle) => ({
      x: 0,
      y: 0,
      width: handle.options.width,
      height: handle.options.height,
    }),
    windowIsVisible: () => true,
    createSurfaceIOSurface: (width, height, scale) => ({
      handle: { id: ++seq, width, height, scale },
      iosurfaceId: seq,
    }),
    createSurface: (width, height, scale) => ({
      id: ++seq,
      width,
      height,
      scale,
    }),
    surfaceSize: (handle) => ({
      width: handle.width,
      height: handle.height,
      scale: handle.scale,
    }),
  };
  return new Proxy(base, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
}

function appOver(native) {
  const app = new CocoaApp(native);
  setScaleForTests(app, 2, 'cocoa');
  setScreensForTests(app, {
    monitors: [{ x: 0, y: 0, width: 2880, height: 1800 }],
    workArea: { x: 0, y: 0, width: 2880, height: 1750 },
  });
  setCompositingForTests(app, true);
  return app;
}

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await root.unmount();
});

// --- the translation ---------------------------------------------------------

describe('panelSpec', () => {
  test('open: multiple, filters through the OS type database, where it opens', () => {
    const spec = panelSpec(
      'open',
      {
        title: 'Pick an image',
        acceptLabel: 'Import',
        multiple: true,
        defaultFolder: '/Users/me/Pictures',
        filters: [
          { name: 'Images', extensions: ['.png', 'jpg', 'png'] },
          { name: 'Data', mimeTypes: ['application/json'] },
        ],
      },
      contentTypeFor,
    );
    assert.deepEqual(spec, {
      title: 'Pick an image',
      message: 'Pick an image',
      prompt: 'Import',
      directoryURL: '/Users/me/Pictures',
      multiple: true,
      allowedContentTypes: ['public.png', 'public.jpeg', 'public.json'],
    });
  });

  test('a MIME type reaches the panel — the whole point over osascript', () => {
    const spec = panelSpec(
      'open',
      { filters: [{ name: 'Images', mimeTypes: ['image/png'] }] },
      contentTypeFor,
    );
    assert.deepEqual(spec.allowedContentTypes, ['public.png']);
  });

  test('a filter the OS knows nothing of is no filter, and no title is no message', () => {
    const spec = panelSpec(
      'open',
      { filters: [{ name: 'Odd', extensions: ['zzz'] }] },
      contentTypeFor,
    );
    assert.equal('allowedContentTypes' in spec, false);
    assert.equal('message' in spec, false, 'the panel says Open on its own');
    assert.equal(spec.multiple, false);
  });

  test('save: the name, or the path split into where and what', () => {
    assert.deepEqual(
      panelSpec('save', { defaultName: 'notes.md', defaultFolder: '/tmp' }),
      {
        directoryURL: '/tmp',
        canCreateDirectories: true,
        nameFieldStringValue: 'notes.md',
      },
    );
    const byPath = panelSpec('save', {
      defaultName: 'ignored.md',
      defaultPath: '/Users/me/Documents/report.md',
    });
    assert.equal(byPath.directoryURL, '/Users/me/Documents');
    assert.equal(byPath.nameFieldStringValue, 'report.md');
    assert.equal('multiple' in byPath, false, 'a save is one file');
  });

  test('folder: directories, and no type filter however many were given', () => {
    const spec = panelSpec(
      'folder',
      { multiple: true, filters: [{ name: 'x', extensions: ['png'] }] },
      contentTypeFor,
    );
    assert.deepEqual(spec, {
      multiple: true,
      directory: true,
      canCreateDirectories: true,
    });
  });
});

// --- the panel ---------------------------------------------------------------

describe('CocoaFilePanels.show', () => {
  test('a sheet on the window: paths back through the callback, later', async () => {
    const native = fakeNative({ answer: () => ['/a.png', '/b.png'] });
    const app = appOver(native);
    const wnd = app.createWindow({ width: 300, height: 200 });
    const panels = new CocoaFilePanels(app);
    let settled = false;
    const pending = panels
      .show('open', { multiple: true }, wnd)
      .then((r) => ((settled = true), r));
    assert.equal(native.panels.length, 1, 'presented at once');
    assert.equal(native.panels[0].spec.window, wnd._h, 'as a sheet on it');
    assert.equal(settled, false, 'and answered on a later tick');
    assert.deepEqual(await pending, ['/a.png', '/b.png']);
  });

  test('a save answers one path, still in a list', async () => {
    const native = fakeNative({ answer: () => '/out.txt' });
    const app = appOver(native);
    const panels = new CocoaFilePanels(app);
    assert.deepEqual(await panels.show('save', {}, null), ['/out.txt']);
    assert.equal('window' in native.panels[0].spec, false, 'app-modal');
  });

  test('a cancel is the ladder’s cancel', async () => {
    const native = fakeNative({ answer: () => null });
    const panels = new CocoaFilePanels(appOver(native));
    await assert.rejects(
      panels.show('open', {}, null),
      (err) => err instanceof PortalCancelledError,
    );
  });

  test('an abort dismisses the sheet and rejects with the abort', async () => {
    let cb;
    const native = fakeNative();
    native.openPanel = (spec, fn) => {
      cb = fn;
      const handle = { id: 1, spec, cb: fn };
      native.panels.push(handle);
      return handle; // never answers on its own
    };
    const app = appOver(native);
    const wnd = app.createWindow({ width: 300, height: 200 });
    const panels = new CocoaFilePanels(app);
    const ac = new AbortController();
    const pending = panels.show('open', { signal: ac.signal }, wnd);
    ac.abort();
    await assert.rejects(pending, /abort/i);
    assert.deepEqual(native.cancelled, [1], 'the panel came down');
    cb(null); // the bridge's own answer to the dismissal: already settled
  });

  test('a signal that has already fired never presents a panel', async () => {
    const native = fakeNative();
    const panels = new CocoaFilePanels(appOver(native));
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(panels.show('open', { signal: ac.signal }), /abort/i);
    assert.equal(native.panels.length, 0);
  });
});

// --- the ladder --------------------------------------------------------------

describe('the ladder reaches the native panel', () => {
  test('openFile names a window on the cocoa backend and gets its sheet', async () => {
    // a pick for the open panel; a cancel for the save and the folder
    const native = fakeNative({
      answer: (kind, spec) =>
        kind === 'open' && !spec.directory ? ['/picked.png'] : null,
    });
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    const win = React.createRef();
    root.render(h('window', { ref: win, width: 300, height: 200 }, h('box')));
    await tick();

    const paths = await openFile({
      parentWindow: win,
      filters: [{ name: 'Images', extensions: ['png'] }],
    });
    assert.deepEqual(paths, ['/picked.png']);
    const [panel] = native.panels;
    assert.equal(panel.spec.window, win.current._h, 'a sheet on that window');
    assert.deepEqual(panel.spec.allowedContentTypes, ['public.png']);

    assert.equal(await saveFile({ parentWindow: win }), null, 'cancel → null');
    assert.equal(await selectFolder({ parentWindow: win }), null);
    assert.equal(native.panels[2].spec.directory, true);
  });

  test('fileDialogBackend says cocoa while a cocoa root is showing a window', async () => {
    const native = fakeNative();
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    root.render(h('window', { width: 300, height: 200 }, h('box')));
    await tick();
    assert.equal(await fileDialogBackend(), 'cocoa');
  });

  test('useFileDialog parents the sheet to the window the component is in', async () => {
    const native = fakeNative({ answer: () => ['/from-hook.md'] });
    const app = appOver(native);
    const root = await createRoot({ app });
    roots.push(root);
    let open;
    function Probe() {
      const dialogs = useFileDialog();
      open = () =>
        dialogs.openFile({
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
      return h('box');
    }
    const win = React.createRef();
    root.render(h('window', { ref: win, width: 300, height: 200 }, h(Probe)));
    await tick();

    assert.deepEqual(await open(), ['/from-hook.md']);
    assert.equal(native.panels[0].spec.window, win.current._h);
    assert.deepEqual(native.panels[0].spec.allowedContentTypes, [
      'net.daringfireball.markdown',
    ]);
  });

  test('backend: cocoa with no cocoa window is a typed rejection', async () => {
    await assert.rejects(
      openFile({ backend: 'cocoa', parentWindow: 12345 }),
      (err) => err instanceof NoFileDialogError,
    );
  });

  test('a bridge without panels puts no rung on the ladder', () => {
    const native = fakeNative();
    native.openPanel = undefined;
    const app = appOver(native);
    assert.equal(app.filePanels, null);
  });
});
